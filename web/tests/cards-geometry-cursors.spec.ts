import { expect, test, type Page } from "@playwright/test";

async function fixture(page: Page) {
  await page.route(/^http:\/\/127\.0\.0\.1:[0-9]+\/$/, (route) =>
    route.fulfill({
      contentType: "text/html",
      body: "<!doctype html><html><body></body></html>",
    }),
  );
  await page.goto("/");
  await page.evaluate(async () => {
    const { ChartCard } = await import("/src/cards.ts");
    const { newChart } = await import("/src/workspace.ts");
    document.body.style.cssText =
      "margin:12px;background:#191c20;color:#ddd;font:13px system-ui;--surface:#202429;--surface-raised:#252a30;--border:#42474e;--text:#ddd;--muted:#aaa;--control-border:#555;--accent:#7dd3fc";
    const grid = document.createElement("main");
    grid.style.cssText =
      "display:flex;flex-wrap:wrap;gap:12px;align-items:flex-start";
    const host = document.createElement("div");
    host.style.cssText =
      "flex:0 1 var(--card-width,600px);max-width:100%;min-width:min(300px,100%)";
    grid.append(host);
    document.body.append(grid);
    const runs = ["a", "b"].map((id, index) => ({
      id,
      name: `Run ${id} ${"long-name-".repeat(25)}`,
      experiment_id: "e",
      status: "finished",
      params: {},
      tags: {},
      created_at: index,
      updated_at: 0,
    }));
    const catalog = {
      experiments: [],
      runs,
      series: runs.flatMap((run) =>
        ["train/loss", "eval/loss"].map((key) => ({
          run_id: run.id,
          key,
          kind: "metric",
          count: 7,
          last_step: 6,
          last_timestamp: 6,
          last_value: 2,
        })),
      ),
    };
    let spec = newChart(
      "timeseries",
      ["train/loss", "eval/loss"],
      "Comparison",
    );
    spec.id = "geometry";
    spec.layout = JSON.parse(
      localStorage.getItem("card-test-layout") ?? "null",
    ) ?? { width: 620, height: 450 };
    let loads = 0;
    const context = {
      api: {},
      catalog,
      selectedRunIds: ["a", "b"],
      store: {
        clear() {},
        async load() {
          loads++;
          return [0, 2, 2, 0, 2, 0, 2].map((value, step) => ({
            seq: step + 1,
            step,
            timestamp: step,
            value,
          }));
        },
      },
    };
    const events: unknown[] = [];
    const state: any = {
      reject: false,
      events,
      context,
      get loads() {
        return loads;
      },
    };
    const actions = {
      onEdit() {},
      onRemove() {},
      onMove() {},
      onDuplicate() {},
      onResize() {},
      onDimensions(_id: string, layout: any) {
        events.push(layout);
        if (state.reject) return false;
        localStorage.setItem("card-test-layout", JSON.stringify(layout));
        state.card.setSpec({ ...state.card.spec, layout });
      },
    };
    state.card = new ChartCard(host, spec, context, actions);
    (window as any).geometry = state;
  });
  await expect(page.locator(".u-over")).toBeVisible();
}

async function snapshot(page: Page) {
  return page.evaluate(() => {
    const s = (window as any).geometry,
      c = s.card;
    return {
      layout: c.spec.layout,
      pins: c.pins,
      viewport: c.plot.viewport(),
      loads: s.loads,
      width: c.plot.chart.width,
      height: c.plot.chart.height,
      history: c.plot.canGoBack(),
      events: s.events.length,
    };
  });
}

async function resize(page: Page, dx: number, dy: number, finish = true) {
  const box = (await page
    .getByRole("button", { name: "Resize chart", exact: true })
    .boundingBox())!;
  await page.mouse.move(box.x + 10, box.y + 10);
  await page.mouse.down();
  await page.mouse.move(box.x + 10 + dx, box.y + 10 + dy, { steps: 5 });
  if (finish) await page.mouse.up();
}

test("independent pointer dimensions persist once, reload, cancel and storage failure roll back", async ({
  page,
}) => {
  await fixture(page);
  await resize(page, 100, 70, false);
  expect((await snapshot(page)).events).toBe(0);
  await page.mouse.up();
  await expect
    .poll(async () => (await snapshot(page)).layout)
    .toEqual({ width: 720, height: 520 });
  expect((await snapshot(page)).events).toBe(1);
  await resize(page, -50, 0);
  expect((await snapshot(page)).layout).toEqual({ width: 670, height: 520 });
  await resize(page, 0, 80, false);
  await page.keyboard.press("Escape");
  await page.mouse.up();
  expect((await snapshot(page)).layout).toEqual({ width: 670, height: 520 });
  expect((await snapshot(page)).events).toBe(2);
  await page.evaluate(() => {
    (window as any).geometry.reject = true;
  });
  await resize(page, 70, 30);
  expect((await snapshot(page)).layout).toEqual({ width: 670, height: 520 });
  const rect = await page.locator(".chart-card").boundingBox();
  expect(rect?.width).toBe(670);
  expect(rect?.height).toBe(520);
  await fixture(page);
  expect((await snapshot(page)).layout).toEqual({ width: 670, height: 520 });
});

test("keyboard dimensions clamp and desired width survives a narrow viewport", async ({
  page,
}, info) => {
  await fixture(page);
  const handle = page.getByRole("button", {
    name: "Resize chart",
    exact: true,
  });
  await handle.focus();
  await page.keyboard.press("ArrowRight");
  await page.keyboard.press("Shift+ArrowDown");
  expect((await snapshot(page)).layout).toEqual({ width: 630, height: 500 });
  await page.setViewportSize({ width: 390, height: 844 });
  await expect
    .poll(async () => (await page.locator(".chart-card").boundingBox())!.width)
    .toBeLessThanOrEqual(366);
  expect((await snapshot(page)).layout.width).toBe(630);
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(
    390,
  );
  await page.screenshot({ path: info.outputPath("narrow-card.png") });
  await page.setViewportSize({ width: 1500, height: 1100 });
  await expect
    .poll(async () => (await page.locator(".chart-card").boundingBox())!.width)
    .toBe(630);
  await page.evaluate(() => {
    const c = (window as any).geometry.card;
    c.setSpec({ ...c.spec, layout: { width: 300, height: 240 } });
  });
  await handle.focus();
  await page.keyboard.press("ArrowLeft");
  await page.keyboard.press("ArrowUp");
  expect((await snapshot(page)).layout).toEqual({ width: 300, height: 240 });
});

test("resize and maximize preserve canvas identity, viewport, pins, history and loaded data", async ({
  page,
}, info) => {
  await fixture(page);
  await page.evaluate(() => {
    const s = (window as any).geometry,
      c = s.card;
    c.setPin("a", 1);
    c.setPin("yB", 1.5);
    c.plot.zoom(1.5);
    s.canvas = c.plot.chart;
    s.data = c.data;
    s.navigation = c.plot.navigation;
  });
  const before = await snapshot(page);
  await resize(page, 90, 80);
  await expect
    .poll(async () => (await snapshot(page)).height)
    .toBeGreaterThan(before.height + 60);
  await page
    .getByRole("button", { name: "Maximize chart", exact: true })
    .click();
  await expect
    .poll(async () => (await snapshot(page)).height)
    .toBeGreaterThan(900);
  expect((await snapshot(page)).width).toBeGreaterThan(1400);
  await page.screenshot({ path: info.outputPath("maximized-card.png") });
  await page
    .getByRole("button", { name: "Restore chart", exact: true })
    .click();
  const after = await snapshot(page);
  expect(after.layout).toEqual({ width: 710, height: 530 });
  expect(after.viewport).toEqual(before.viewport);
  expect(after.pins).toEqual(before.pins);
  expect(after.loads).toBe(before.loads);
  expect(after.history).toBe(true);
  expect(
    await page.evaluate(() => {
      const s = (window as any).geometry;
      return (
        s.card.plot.chart === s.canvas &&
        s.card.data === s.data &&
        s.card.plot.navigation === s.navigation
      );
    }),
  ).toBe(true);
});

test("collapsed aligned legend and bounded hover use shared display colors without persistence", async ({
  page,
}) => {
  await fixture(page);
  await expect(page.locator(".card-legend")).toBeHidden();
  await page.getByText("Show legend", { exact: true }).click();
  await expect(page.getByRole("listitem")).toHaveCount(4);
  expect(
    await page
      .locator(".card-legend-swatch")
      .evaluateAll((nodes) =>
        nodes.map((node) => getComputedStyle(node).backgroundColor),
      ),
  ).toEqual([
    "rgb(96, 165, 250)",
    "rgb(96, 165, 250)",
    "rgb(192, 132, 252)",
    "rgb(192, 132, 252)",
  ]);
  await moveCrossingPointer(page, 2, 2);
  await expect(page.locator(".card-hover-row")).toHaveCount(2);
  await expect(page.locator(".card-hover-more")).toHaveCount(0);
  await expect(page.locator(".card-hover")).not.toContainText("train/loss");
  await expect(page.locator(".card-hover")).not.toContainText("eval/loss");
  await expect(page.locator(".card-legend-value")).toHaveCount(4);
  const dimensions = await page.locator(".card-hover").evaluate((node) => ({
    width: node.clientWidth,
    height: node.clientHeight,
    scroll: node.scrollWidth,
  }));
  expect(dimensions.width).toBeLessThan(330);
  expect(dimensions.height).toBeLessThan(125);
  expect(dimensions.scroll).toBe(dimensions.width);
  expect(
    await page.evaluate(() => (window as any).geometry.card.spec.config.runs),
  ).toEqual({});
});

test("refreshColors changes existing strokes but preserves numerical data and navigation", async ({
  page,
}) => {
  await fixture(page);
  await page.evaluate(() => {
    const s = (window as any).geometry,
      c = s.card;
    c.plot.zoom(2);
    c.setPin("a", 2);
    s.chart = c.plot.chart;
    s.data = c.data;
    s.fn = c.data[0].fn;
    c.spec.config.runs[c.sources[0].id] = { color: "#ff0088" };
  });
  const before = await snapshot(page);
  await page.evaluate(() => (window as any).geometry.card.refreshColors());
  const after = await snapshot(page);
  expect(after).toEqual(before);
  expect(
    await page.evaluate(() => {
      const s = (window as any).geometry,
        c = s.card;
      return {
        same:
          c.plot.chart === s.chart &&
          c.data === s.data &&
          c.data[0].fn === s.fn,
        color: c.plot.chart.series[1].stroke(),
      };
    }),
  ).toEqual({ same: true, color: "#ff0088" });
});

test("horizontal A/B inspection includes every crossing and plateau plus delta Y", async ({
  page,
}) => {
  await fixture(page);
  await page.getByRole("button", { name: "Add horizontal cursor" }).click();
  await page.getByText("Edit positions", { exact: true }).click();
  await page.getByRole("spinbutton", { name: "Cursor A level" }).fill("1");
  await page.getByRole("spinbutton", { name: "Cursor A level" }).press("Tab");
  await page.getByRole("spinbutton", { name: "Cursor B level" }).fill("2");
  await page.getByRole("spinbutton", { name: "Cursor B level" }).press("Tab");
  await expect(page.locator(".card-position-readout output")).toHaveText([
    "1",
    "2",
    "1",
  ]);
  await expect(page.locator(".card-crossings")).toHaveCount(8);
  await expect(page.locator(".card-crossings").first()).toContainText(
    "5 crossings",
  );
  await page.getByText("Per-run values / crossings", { exact: true }).click();
  await page.locator(".card-crossings").first().locator("summary").click();
  await expect(
    page.locator(".card-crossings").first().locator("div"),
  ).toHaveText("0.5, 2.5, 3.5, 4.5, 5.5");
  await expect(page.locator(".card-crossings").nth(4)).toContainText(
    "1 intervals",
  );
  await expect(
    page.getByRole("button", { name: "Add horizontal cursor" }),
  ).toHaveAttribute("aria-pressed", "false");
});

test("coincident edge pin labels are opaque-backed, clamped and collision-free", async ({
  page,
}, info) => {
  await fixture(page);
  await page.evaluate(() => {
    const c = (window as any).geometry.card,
      v = c.plot.viewport();
    c.plot.setPins({
      a: v.x[1],
      b: v.x[1],
      yA: v.y[1],
      yB: v.y[1],
      threshold: v.y[1],
    });
  });
  await checkEdgeLabels(page);
  await info.attach("coincident-top-right", {
    body: await page.screenshot({
      path: info.outputPath("coincident-top-right.png"),
    }),
    contentType: "image/png",
  });
});

async function checkEdgeLabels(page: Page) {
  await page.mouse.move(1490, 1090);
  const result = await page.evaluate(() => {
    const plot = (window as any).geometry.card.plot;
    return {
      labels: plot.pinLabels,
      bounds: plot.chart.bbox,
      ratio: devicePixelRatio,
      canvasWidth: plot.chart.ctx.canvas.width,
    };
  });
  expect(result.labels, JSON.stringify(result)).toHaveLength(5);
  expect(result.labels.map((label: any) => [label.axis, label.text])).toEqual([
    ["y", "A"],
    ["y", "B"],
    ["y", "T"],
    ["x", "A"],
    ["x", "B"],
  ]);
  const inset = 2 * result.ratio;
  for (const [index, label] of result.labels.entries()) {
    expect(label.x).toBeGreaterThanOrEqual(result.bounds.left + inset);
    expect(label.y).toBeGreaterThanOrEqual(result.bounds.top + inset);
    expect(label.x + label.width).toBeLessThanOrEqual(
      result.bounds.left + result.bounds.width - inset + 0.01,
    );
    expect(label.y + label.height).toBeLessThanOrEqual(
      result.bounds.top + result.bounds.height - inset + 0.01,
    );
    if (label.axis === "x") expect(label.y).toBe(result.bounds.top + inset);
    else
      expect(label.x + label.width).toBeCloseTo(
        result.bounds.left + result.bounds.width - inset,
        5,
      );
    for (const other of result.labels.slice(index + 1))
      expect(
        label.x < other.x + other.width + result.ratio &&
          label.x + label.width + result.ratio > other.x &&
          label.y < other.y + other.height + result.ratio &&
          label.y + label.height + result.ratio > other.y,
      ).toBe(false);
  }
  // Decode the actual browser screenshot, not merely the backing canvas. This
  // catches DOM occlusion, clipping and transparent backgrounds as well as text.
  const png = await page.locator(".u-wrap canvas").screenshot();
  const pixels = await page.evaluate(
    async ({ dataURL, labels, canvasWidth, ratio }) => {
      const image = new Image();
      image.src = dataURL;
      await image.decode();
      const canvas = document.createElement("canvas");
      canvas.width = image.width;
      canvas.height = image.height;
      const ctx = canvas.getContext("2d")!;
      ctx.drawImage(image, 0, 0);
      const scale = image.width / canvasWidth;
      return labels.map((label: any) => {
        const x = Math.round(label.x * scale),
          y = Math.round(label.y * scale);
        const width = Math.floor(label.width * scale),
          height = Math.floor(label.height * scale);
        // Sample the same CSS-pixel interior at either device scale.
        const near = Math.round(2 * ratio * scale),
          far = Math.round(3 * ratio * scale);
        const corners = [
          [near, near],
          [width - far, near],
          [near, height - far],
          [width - far, height - far],
        ].map(([dx, dy]) =>
          Array.from(ctx.getImageData(x + dx, y + dy, 1, 1).data),
        );
        const data = ctx.getImageData(x + 3, y + 3, width - 6, height - 6).data;
        const color = label.color
          .match(/\w\w/g)
          .map((hex: string) => parseInt(hex, 16));
        let ink = 0;
        for (let i = 0; i < data.length; i += 4)
          if (
            color.every(
              (channel: number, j: number) =>
                Math.abs(data[i + j] - channel) < 35,
            )
          )
            ink++;
        return { corners, ink, label };
      });
    },
    {
      dataURL: "data:image/png;base64," + png.toString("base64"),
      labels: result.labels,
      canvasWidth: result.canvasWidth,
      ratio: result.ratio,
    },
  );
  for (const pixel of pixels) {
    for (const corner of pixel.corners)
      expect(corner, JSON.stringify(pixel)).toEqual([32, 36, 41, 255]);
    expect(pixel.ink).toBeGreaterThan(3);
  }
}

test("edge packing is deterministic, nearest, immutable and never shrinks text", async ({
  page,
}) => {
  await fixture(page);
  const result = await page.evaluate(async () => {
    const { placePinLabels } = await import("/src/plot.ts");
    const label = (text: string, axis: "x" | "y", x: number, y: number) => ({
      text,
      axis,
      x,
      y,
      width: 18,
      height: 20,
      color: "#7dd3fc",
    });
    const labels = [
      label("A", "y", 0, 0),
      label("A", "x", 999, 0),
      label("B", "x", 999, 0),
      label("B", "y", 0, 0),
      label("T", "y", 0, 0),
    ];
    const before = JSON.stringify(labels);
    const bounds = { x: 2, y: 2, width: 196, height: 96 };
    const packed = placePinLabels(labels, bounds);
    return {
      packed,
      repeat: placePinLabels(labels, bounds),
      unchanged: JSON.stringify(labels) === before,
      tiny: placePinLabels(labels, { x: 2, y: 2, width: 17, height: 19 }),
      short: placePinLabels(labels, { x: 2, y: 2, width: 196, height: 20 }),
    };
  });
  expect(result.unchanged).toBe(true);
  expect(result.repeat).toEqual(result.packed);
  expect(result.packed.map(({ axis, x, y }: any) => [axis, x, y])).toEqual([
    ["y", 180, 2],
    ["y", 180, 25],
    ["y", 180, 48],
    ["x", 159, 2],
    ["x", 138, 2],
  ]);
  expect(result.tiny).toEqual([]);
  expect(result.short).toHaveLength(3);
  expect(
    result.short.every(
      (label: any) => label.width === 18 && label.height === 20,
    ),
  ).toBe(true);
});

for (const ratio of [1, 2])
  test.describe(`edge badges at DPR ${ratio}`, () => {
    test.use({ deviceScaleFactor: ratio });
    for (const reversedLog of [false, true])
      test(`${reversedLog ? "reversed log" : "linear"} labels stay top/right at every corner and card size`, async ({
        page,
      }, info) => {
        test.setTimeout(90000);
        await fixture(page);
        if (reversedLog) {
          await page.evaluate(() => {
            const c = (window as any).geometry.card;
            c.setSpec({
              ...c.spec,
              config: {
                ...c.spec.config,
                xScale: "log",
                yScale: "log",
                xMin: 1,
                xMax: 100,
                yMin: 1,
                yMax: 100,
                advanced: { scales: { x: { dir: -1 }, y: { dir: -1 } } },
              },
            });
          });
          await expect
            .poll(() =>
              page.evaluate(
                () => (window as any).geometry.card.plot.config.xScale,
              ),
            )
            .toBe("log");
        }
        for (const size of ["normal", "resized", "minimum", "maximized"]) {
          if (size === "resized") await resize(page, 120, 80);
          if (size === "minimum") {
            await page.evaluate(() => {
              const c = (window as any).geometry.card;
              c.setSpec({ ...c.spec, layout: { width: 300, height: 240 } });
            });
          }
          if (size === "maximized")
            await page
              .getByRole("button", { name: "Maximize chart", exact: true })
              .click();
          // ResizeObserver updates the canvas on the next frame.
          await page.evaluate(
            () =>
              new Promise<void>((resolve) =>
                requestAnimationFrame(() =>
                  requestAnimationFrame(() => resolve()),
                ),
              ),
          );
          for (const xEnd of [0, 1])
            for (const yEnd of [0, 1]) {
              const before = await page.evaluate(
                ({ xEnd, yEnd }) => {
                  const c = (window as any).geometry.card,
                    p = c.plot,
                    v = p.viewport();
                  const pins = {
                    a: v.x[xEnd],
                    b: v.x[xEnd],
                    yA: v.y[yEnd],
                    yB: v.y[yEnd],
                    threshold: v.y[yEnd],
                  };
                  p.setPins(pins);
                  return { pins, viewport: v };
                },
                { xEnd, yEnd },
              );
              await checkEdgeLabels(page);
              const after = await page.evaluate(() => {
                const p = (window as any).geometry.card.plot;
                return { pins: p.pins, viewport: p.viewport() };
              });
              expect(after).toEqual(before);
            }
          await info.attach(`${size}-coincident-edge-labels`, {
            body: await page.screenshot({
              path: info.outputPath(`${size}-coincident-edge-labels.png`),
            }),
            contentType: "image/png",
          });
        }
      });
  });

test("axis display defaults use the logged key or honest mixed title, explicit labels win", async ({
  page,
}) => {
  await fixture(page);
  expect(
    await page.evaluate(() => (window as any).geometry.card.plot.config.yLabel),
  ).toBe("Metric values");
  await page.evaluate(() => {
    const c = (window as any).geometry.card;
    c.setSpec({
      ...c.spec,
      source: { mode: "selected", keys: ["train/loss"] },
    });
  });
  await expect
    .poll(() =>
      page.evaluate(() => (window as any).geometry.card.plot.config.yLabel),
    )
    .toBe("train/loss");
  await page.evaluate(() => {
    const c = (window as any).geometry.card;
    c.setSpec({
      ...c.spec,
      config: { ...c.spec.config, yLabel: "Loss (nats)" },
    });
  });
  await expect
    .poll(() =>
      page.evaluate(() => (window as any).geometry.card.plot.config.yLabel),
    )
    .toBe("Loss (nats)");
});

test("sixty-run legends and hover readouts stay bounded without widening the card", async ({
  page,
}, info) => {
  await fixture(page);
  await page.evaluate(() => {
    const s = (window as any).geometry,
      c = s.card;
    const runs = Array.from({ length: 60 }, (_, i) => ({
      ...s.context.catalog.runs[0],
      id: `run-${i}`,
      name: `Run ${i}: ${"long metric experiment name ".repeat(15)}`,
      created_at: i,
    }));
    const series = runs.map((run) => ({
      ...s.context.catalog.series[0],
      run_id: run.id,
    }));
    c.setSpec({
      ...c.spec,
      source: { mode: "selected", keys: ["train/loss"] },
    });
    c.setContext({
      ...s.context,
      catalog: { ...s.context.catalog, runs, series },
      selectedRunIds: runs.map((run) => run.id),
    });
  });
  await expect
    .poll(() => page.evaluate(() => (window as any).geometry.card.data.length))
    .toBe(60);
  await expect(page.locator(".card-legend")).toBeHidden();
  await page.getByText("Show legend", { exact: true }).click();
  await expect(page.getByRole("listitem")).toHaveCount(60);
  await moveCrossingPointer(page, 2, 2);
  const bounds = await page.evaluate(() => {
    const legend = document.querySelector<HTMLElement>(".card-legend")!;
    const hover = document.querySelector<HTMLElement>(".card-hover")!;
    return {
      legend: legend.clientHeight,
      legendScroll: legend.scrollHeight,
      hover: hover.clientHeight,
      hoverScroll: hover.scrollHeight,
      document: document.documentElement.scrollWidth,
    };
  });
  expect(bounds.legend).toBeLessThanOrEqual(105);
  expect(bounds.legendScroll).toBeGreaterThan(500);
  expect(bounds.hover).toBeLessThanOrEqual(125);
  expect(bounds.hoverScroll).toBeLessThanOrEqual(125);
  await expect(page.locator(".card-hover-row")).toHaveCount(4);
  await expect(page.locator(".card-hover-more")).toHaveCount(0);
  await page.mouse.move(0, 0);
  await expect(page.locator(".card-legend-coordinate")).toHaveText("At step 2");
  await expect(page.locator(".card-legend-value").last()).toHaveText("2");
  await page.locator(".card-legend").focus();
  await page.keyboard.press("End");
  await expect
    .poll(() => page.locator(".card-legend").evaluate((el) => el.scrollTop))
    .toBeGreaterThan(100);
  expect(bounds.document).toBe(1500);
  await page.screenshot({ path: info.outputPath("dense-card-readouts.png") });
  const plotHeight = (await page.locator(".u-over").boundingBox())!.height;
  await page.getByRole("button", { name: "Add horizontal cursor" }).click();
  await page.evaluate(() => {
    const c = (window as any).geometry.card;
    c.setPin("yA", 1);
    c.setPin("yB", 2);
  });
  await page.getByText("Per-run values / crossings", { exact: true }).click();
  await expect(page.locator(".card-crossings")).toHaveCount(120);
  const results = await page
    .locator(".card-series-results")
    .evaluate((el) => ({ height: el.clientHeight, scroll: el.scrollHeight }));
  expect(results.height).toBeLessThanOrEqual(190);
  expect(results.scroll).toBeGreaterThan(500);
  expect((await page.locator(".u-over").boundingBox())!.height).toBe(
    plotHeight,
  );
  await page.screenshot({ path: info.outputPath("dense-cursor-results.png") });
});

test("pointer cancellation rolls transient geometry back without persistence", async ({
  page,
}) => {
  await fixture(page);
  const before = await snapshot(page);
  await resize(page, 50, 50, false);
  await page
    .getByRole("button", { name: "Resize chart", exact: true })
    .dispatchEvent("pointercancel", { pointerId: 1 });
  await page.mouse.up();
  expect((await snapshot(page)).layout).toEqual(before.layout);
  expect((await snapshot(page)).events).toBe(0);
  await expect
    .poll(async () => (await page.locator(".chart-card").boundingBox())!.height)
    .toBe(before.layout.height);
});

test("cursor pairs return to zoom and existing horizontal/vertical pins drag directly", async ({
  page,
}) => {
  await fixture(page);
  const at = async (x: number, y: number) =>
    page.evaluate(
      async ({ x, y }) => {
        await new Promise(requestAnimationFrame);
        await new Promise(requestAnimationFrame);
        const u = (window as any).geometry.card.plot.chart,
          rect = u.over.getBoundingClientRect();
        return {
          x: rect.left + u.valToPos(x, "x"),
          y: rect.top + u.valToPos(y, "y"),
        };
      },
      { x, y },
    );
  const drag = async (x1: number, y1: number, x2: number, y2: number) => {
    const a = await at(x1, y1),
      b = await at(x2, y2);
    await page.mouse.move(a.x, a.y);
    await page.mouse.down();
    await page.mouse.move(b.x, b.y, { steps: 5 });
    await page.mouse.up();
  };
  await page.getByRole("button", { name: "Add horizontal cursor" }).click();
  const point = await at(3, 0.8);
  await page.mouse.click(point.x, point.y);
  await expect
    .poll(() => page.evaluate(() => (window as any).geometry.card.mode))
    .toBe("inspect");
  await expect(
    page.getByRole("button", {
      name: "Place horizontal cursor B",
      includeHidden: true,
    }),
  ).toHaveAttribute("aria-pressed", "true");
  const second = await at(4, 1.7);
  await page.mouse.click(second.x, second.y);
  expect((await snapshot(page)).pins.yB).toBeCloseTo(1.7, 1);
  expect(await page.evaluate(() => (window as any).geometry.card.mode)).toBe(
    "zoom",
  );
  expect((await snapshot(page)).pins.yA).toBeCloseTo(0.8, 1);
  await expect(
    page.getByRole("button", {
      name: "Place horizontal cursor A",
      includeHidden: true,
    }),
  ).toHaveAttribute("aria-pressed", "false");
  const before = await snapshot(page);
  await drag(3, 0.8, 3, 1.3);
  expect((await snapshot(page)).pins.yA).toBeCloseTo(1.3, 1);
  expect((await snapshot(page)).viewport).toEqual(before.viewport);
  await page.getByRole("button", { name: "Add vertical cursor" }).click();
  const vertical = await at(1, 0.3);
  await page.mouse.click(vertical.x, vertical.y);
  expect((await snapshot(page)).pins.a).toBeCloseTo(1, 1);
  await drag(1, 0.3, 2, 0.3);
  expect((await snapshot(page)).pins.a).toBeCloseTo(2, 1);
  const pins = (await snapshot(page)).pins;
  await drag(2.6, 0.4, 4.5, 1.1);
  const after = await snapshot(page);
  expect(after.viewport.x[1] - after.viewport.x[0]).toBeLessThan(
    before.viewport.x[1] - before.viewport.x[0],
  );
  expect(after.pins).toEqual(pins);
});

test("threshold clear action also removes every cursor without changing the camera", async ({ page }) => {
  await fixture(page);
  await page.getByRole("button", { name: "Zoom in", exact: true }).click();
  await page.evaluate(() => {
    const c = (window as any).geometry.card;
    for (const [pin, value] of Object.entries({ a: 1, b: 5, yA: 0.3, yB: 1.7, threshold: 1 }))
      c.setPin(pin, value);
    c.mode = "threshold";
    c.configure();
  });
  const before = await snapshot(page);
  await page.getByText("Edit positions", { exact: true }).click();
  await page.getByRole("button", { name: "Clear cursors", exact: true }).click();
  expect(await snapshot(page)).toEqual({
    ...before,
    pins: { a: null, b: null, threshold: null, yA: null, yB: null },
  });
  expect(await page.evaluate(() => (window as any).geometry.card.mode)).toBe("zoom");
  await expect(page.locator(".card-inspection")).toBeHidden();
  await expect(page.locator(".card-crossings")).toHaveCount(0);
});
for (const touch of [false, true]) {
  test.describe(`cursor toolbar ${touch ? "touch" : "mouse"}`, () => {
    test.use({
      hasTouch: touch,
      viewport: touch ? { width: 390, height: 844 } : { width: 1500, height: 1100 },
    });

    for (const armedAxis of ["x", "y"] as const) {
      test(`Clear Cursors removes both pairs while ${armedAxis} is armed and preserves zoom`, async ({ page }) => {
        await fixture(page);
        const axisButton = (axis: "x" | "y") => page.getByRole("button", {
          name: axis === "x" ? "Add vertical cursor" : "Add horizontal cursor",
          exact: true,
        });
        const activate = async (axis: "x" | "y") => {
          if (touch) await axisButton(axis).tap();
          else await axisButton(axis).click();
        };
        const point = async (x: number, y: number) => page.evaluate(async ({ x, y }) => {
          await new Promise(requestAnimationFrame);
          await new Promise(requestAnimationFrame);
          const u = (window as any).geometry.card.plot.chart;
          const rect = u.over.getBoundingClientRect();
          return { x: rect.left + u.valToPos(x, "x"), y: rect.top + u.valToPos(y, "y") };
        }, { x, y });
        const place = async (x: number, y: number) => {
          const p = await point(x, y);
          if (touch) await page.touchscreen.tap(p.x, p.y);
          else await page.mouse.click(p.x, p.y);
        };
        await activate("x");
        await place(1, 0.4);
        await place(5, 0.4);
        await activate("y");
        await place(3, 0.3);
        await place(3, 1.7);
        // A threshold left by another inspection mode must not survive either.
        await page.evaluate(() => (window as any).geometry.card.setPin("threshold", 1));
        const zoom = page.getByRole("button", { name: "Zoom in", exact: true });
        if (touch) await zoom.tap();
        else await zoom.click();
        await activate(armedAxis);
        await expect(axisButton(armedAxis)).toHaveAttribute("aria-pressed", "true");
        const before = await snapshot(page);
        for (const pin of ["a", "b", "yA", "yB", "threshold"])
          expect(before.pins[pin]).not.toBeNull();
        expect(before.history).toBe(true);
        await expect(page.locator(".card-position-group")).toHaveCount(2);
        await page.getByText("Edit positions", { exact: true }).click();
        const clear = page.getByRole("button", { name: "Clear cursors", exact: true });
        await expect(clear).toHaveCount(1);
        await expect(clear).toHaveText("Clear Cursors");
        await expect(page.getByRole("button", { name: "Hide cursor details" })).toHaveCount(0);
        if (touch) await clear.tap();
        else await clear.click();

        const empty = { a: null, b: null, threshold: null, yA: null, yB: null };
        expect(await snapshot(page)).toEqual({ ...before, pins: empty });
        expect(await page.evaluate(() => (window as any).geometry.card.plot.pins)).toEqual(empty);
        expect(await page.evaluate(() => (window as any).geometry.card.mode)).toBe("zoom");
        for (const axis of ["x", "y"] as const)
          await expect(axisButton(axis)).toHaveAttribute("aria-pressed", "false");
        await expect(page.locator(".card-inspection")).toBeHidden();
        await expect(page.locator(".card-position-readout, .card-crossings, .card-value-table")).toHaveCount(0);
        await place(3, 0.9); // Ordinary clicks/taps cannot recreate cleared pins.
        expect(await snapshot(page)).toEqual({ ...before, pins: empty });
        if (!touch) {
          const p = await point(3.5, 1);
          await page.mouse.move(p.x, p.y);
          await expect(page.locator(".card-hover-row").first()).toBeVisible();
        }
        // Both axes can start fresh, without stale values in the other pair.
        await activate(armedAxis);
        await place(2, 0.8);
        const pin = armedAxis === "x" ? "a" : "yA";
        const fresh = (await snapshot(page)).pins;
        expect(fresh[pin]).toBeCloseTo(armedAxis === "x" ? 2 : 0.8, 1);
        expect({ ...fresh, [pin]: null }).toEqual(empty);
        await expect(page.locator(".card-position-group")).toHaveCount(1);
        expect((await snapshot(page)).viewport).toEqual(before.viewport);
        expect((await snapshot(page)).loads).toBe(before.loads);
      });
    }
    test("active axis toggles off, other axis switches, and pins/camera survive", async ({ page }) => {
      await fixture(page);
      const button = (axis: "x" | "y") => page.getByRole("button", {
        name: axis === "x" ? "Add vertical cursor" : "Add horizontal cursor",
        exact: true,
      });
      const activate = async (axis: "x" | "y") => {
        if (touch) await button(axis).tap();
        else await button(axis).click();
      };
      const point = async (x: number, y: number) => page.evaluate(async ({ x, y }) => {
        await new Promise(requestAnimationFrame);
        await new Promise(requestAnimationFrame);
        const u = (window as any).geometry.card.plot.chart;
        const rect = u.over.getBoundingClientRect();
        return { x: rect.left + u.valToPos(x, "x"), y: rect.top + u.valToPos(y, "y") };
      }, { x, y });
      const place = async (x: number, y: number) => {
        const p = await point(x, y);
        if (touch) await page.touchscreen.tap(p.x, p.y);
        else await page.mouse.click(p.x, p.y);
      };
      const mode = async (axis: "x" | "y" | null) => {
        await expect(button("x")).toHaveAttribute("aria-pressed", String(axis === "x"));
        await expect(button("y")).toHaveAttribute("aria-pressed", String(axis === "y"));
        expect(await page.evaluate(() => (window as any).geometry.card.mode))
          .toBe(axis ? "inspect" : "zoom");
      };

      // Place both real pairs, then zoom so toggling cannot silently reset the camera.
      await activate("x");
      await place(1, 0.4);
      await place(5, 0.4);
      await mode(null);
      await activate("y");
      await place(3, 0.3);
      await place(3, 1.7);
      await mode(null);
      const zoom = page.getByRole("button", { name: "Zoom in", exact: true });
      if (touch) await zoom.tap();
      else await zoom.click();
      const before = await snapshot(page);
      expect(before.pins.a).toBeCloseTo(1, 1);
      expect(before.pins.b).toBeCloseTo(5, 1);
      expect(before.pins.yA).toBeCloseTo(0.3, 1);
      expect(before.pins.yB).toBeCloseTo(1.7, 1);
      expect(before.history).toBe(true);

      for (const axis of ["x", "y"] as const) {
        await activate(axis);
        await mode(axis);
        await activate(axis);
        await mode(null);
        await place(3, 0.9); // An ordinary click/tap must not place another pin.
        expect(await snapshot(page)).toEqual(before);
      }
      await activate("x");
      await mode("x");
      await activate("y");
      await mode("y");
      await activate("x");
      await mode("x");
      await activate("x");
      await mode(null);
      expect(await snapshot(page)).toEqual(before);

      if (!touch) {
        const start = await point(2, 0.7), end = await point(4, 1.3);
        await page.mouse.move(start.x, start.y);
        await page.mouse.down();
        await page.mouse.move(end.x, end.y, { steps: 8 });
        await page.mouse.up();
        const after = await snapshot(page);
        expect(after.viewport.x[1] - after.viewport.x[0])
          .toBeLessThan(before.viewport.x[1] - before.viewport.x[0]);
        expect(after.pins).toEqual(before.pins);
        await mode(null);
      }
    });
  });
}
test("an armed cursor drag zooms without placing or advancing", async ({
  page,
}) => {
  await fixture(page);
  await page
    .getByRole("button", { name: "Add horizontal cursor", exact: true })
    .click();
  const positions = await page.evaluate(async () => {
    await new Promise(requestAnimationFrame);
    await new Promise(requestAnimationFrame);
    const u = (window as any).geometry.card.plot.chart,
      r = u.over.getBoundingClientRect();
    return {
      x: r.left + u.valToPos(3, "x"),
      from: r.top + u.valToPos(0.6, "y"),
      to: r.top + u.valToPos(1.3, "y"),
    };
  });
  await page.mouse.move(positions.x, positions.from);
  await page.mouse.down();
  await page.mouse.move(positions.x, positions.to, { steps: 12 });
  await page.mouse.up();
  expect((await snapshot(page)).pins.yA ?? null).toBeNull();
  expect((await snapshot(page)).history).toBe(true);
  await expect(
    page.getByRole("button", { name: "Add horizontal cursor", exact: true }),
  ).toHaveAttribute("aria-pressed", "true");
  await expect(
    page.getByRole("button", {
      name: "Place horizontal cursor A",
      includeHidden: true,
    }),
  ).toHaveAttribute("aria-pressed", "true");
});

for (const format of ["number", "iso-time"])
  test(`relative crossing readouts use durations with ${format} formatting`, async ({
    page,
  }) => {
    await fixture(page);
    await page.evaluate((format) => {
      const s = (window as any).geometry;
      const catalog = {
        ...s.context.catalog,
        runs: s.context.catalog.runs.map((r: any) => ({ ...r, created_at: 0 })),
      };
      s.card.setSpec({
        ...s.card.spec,
        source: { mode: "selected", keys: ["train/loss"] },
        config: { ...s.card.spec.config, axis: "relative", xFormat: format },
      });
      s.card.setContext({
        ...s.context,
        catalog,
        store: {
          clear() {},
          async load(ref: any) {
            return (
              ref.runId === "a"
                ? [
                    [0, 1],
                    [10000, 3],
                    [20000, 1],
                  ]
                : [
                    [6000, 2],
                    [8000, 2],
                    [20000, 4],
                  ]
            ).map(([timestamp, value], i) => ({
              seq: i + 1,
              step: i,
              timestamp,
              value,
            }));
          },
        },
      });
    }, format);
    await expect(page.locator(".card-status")).toHaveText("");
    await page
      .getByRole("button", { name: "Add horizontal cursor", exact: true })
      .click();
    await page.getByText("Edit positions", { exact: true }).click();
    await page.getByLabel("Cursor A level", { exact: true }).fill("2");
    await page.getByLabel("Cursor A level", { exact: true }).press("Tab");
    const a = page.locator(".card-crossings").filter({ hasText: "Run a" });
    const b = page.locator(".card-crossings").filter({ hasText: "Run b" });
    await page.getByText("Per-run values / crossings", { exact: true }).click();
    await a.locator("summary").click();
    await b.locator("summary").click();
    await expect(a).toContainText("5s, 15s");
    await expect(b).toContainText("6s – 8s");
    await expect(page.locator(".card-results")).not.toContainText("1970");
  });

for (const axis of ["step", "timestamp", "relative", "horizontal"] as const)
  test(`${axis} primary position readout has signed, fractional and zero B-A independent of samples and viewport`, async ({
    page,
  }) => {
    await fixture(page);
    if (axis !== "horizontal") {
      await page.evaluate((axis) => {
        const c = (window as any).geometry.card;
        c.setSpec({ ...c.spec, config: { ...c.spec.config, axis } });
      }, axis);
      await expect(page.locator(".card-status")).toHaveText("");
    }
    const horizontal = axis === "horizontal";
    await page
      .getByRole("button", {
        name: horizontal ? "Add horizontal cursor" : "Add vertical cursor",
        exact: true,
      })
      .click();
    await page.getByText("Edit positions", { exact: true }).click();
    const input = (letter: string) =>
      page.getByLabel(
        `Cursor ${letter} ${horizontal ? "level" : "coordinate"}`,
        { exact: true },
      );
    const base = axis === "timestamp" ? 1700000000000 : 0;
    for (const [a, b, delta] of [
      [base + 10.25, base + 9.75, -0.5],
      [base, base, 0],
      [base, base + 0.5, 0.5],
    ]) {
      await input("A").fill(String(a));
      await input("A").press("Tab");
      await input("B").fill(String(b));
      await input("B").press("Tab");
      const outputs = page.locator(".card-position-readout output");
      await expect(outputs).toHaveCount(3);
      await expect(outputs.nth(2)).toHaveText(
        axis === "timestamp" || axis === "relative"
          ? `${delta} ms`
          : String(delta),
      );
      if (axis === "timestamp")
        await expect(outputs.first()).toContainText("2023-11-14");
      else
        await expect(outputs.first()).toHaveText(
          axis === "relative" ? `${a} ms` : String(a),
        );
      const text = await page.locator(".card-results").innerText();
      const pins = (await snapshot(page)).pins;
      await page.getByRole("button", { name: "Zoom in", exact: true }).click();
      await resize(page, 10, 10);
      expect((await snapshot(page)).pins).toEqual(pins);
      expect(await page.locator(".card-results").innerText()).toBe(text);
    }
    expect(
      await page
        .locator(".card-results")
        .evaluate((el) => el.firstElementChild?.className),
    ).toBe("card-position-readout");
  });

// Keep these fixtures on the real catalog/store/analysis path: one run can own
// several series, and a selected run can have no crossing at the pointer.
type HoverTrace = {
  id: string;
  name?: string;
  key?: string;
  points: [number, number][];
};

async function crossingFixture(
  page: Page,
  traces: HoverTrace[],
  options: { xy?: boolean; config?: Record<string, unknown> } = {},
) {
  await fixture(page);
  await page.evaluate(({ traces, options }) => {
    const s = (window as any).geometry;
    const runs = [...new Map(traces.map((trace) => [trace.id, {
      ...s.context.catalog.runs[0],
      id: trace.id,
      name: trace.name ?? `Run ${trace.id}`,
      created_at: 0,
    }])).values()];
    const keys = [...new Set(traces.map((trace) => trace.key ?? "train/loss"))];
    const series = traces.map((trace) => ({
      ...s.context.catalog.series[0],
      run_id: trace.id,
      key: trace.key ?? "train/loss",
      count: trace.points.length,
    }));
    if (options.xy) for (const run of runs) series.push({
      ...s.context.catalog.series[0], run_id: run.id, key: "coordinates",
      count: traces.find((trace) => trace.id === run.id)!.points.length,
    });
    s.card.setSpec({
      ...s.card.spec,
      source: { mode: "selected", keys },
      ...(options.xy ? { x: { mode: "key", key: "coordinates" } } : {}),
      config: {
        ...s.card.spec.config,
        xMin: 0, xMax: 100, yMin: 0, yMax: 150,
        ...options.config,
        style: { ...s.card.spec.config.style, ...(options.config?.style as object ?? {}) },
      },
    });
    s.context = {
      ...s.context,
      catalog: { ...s.context.catalog, runs, series },
      selectedRunIds: runs.map((run) => run.id),
      store: {
        clear() {},
        async load(ref: any) {
          const xChannel = options.xy && ref.key === "coordinates";
          const trace = traces.find((trace) => trace.id === ref.runId &&
            (xChannel || (trace.key ?? "train/loss") === ref.key));
          return (trace?.points ?? []).map(([x, y], index) => ({
            seq: index + 1,
            step: options.xy ? index : x,
            timestamp: options.xy ? index : x,
            value: xChannel ? x : y,
          }));
        },
      },
    };
    s.card.setContext(s.context);
  }, { traces, options });
  await expect.poll(() => page.evaluate(
    () => (window as any).geometry.card.data.length,
  )).toBe(traces.length);
  await expect(page.locator(".card-status")).toHaveText("");
}

async function moveCrossingPointer(page: Page, x: number, y: number) {
  const point = await page.evaluate(async ({ x, y }) => {
    await new Promise(requestAnimationFrame);
    await new Promise(requestAnimationFrame);
    const u = (window as any).geometry.card.plot.chart;
    const rect = u.over.getBoundingClientRect();
    return { x: rect.left + u.valToPos(x, "x"), y: rect.top + u.valToPos(y, "y") };
  }, { x, y });
  await page.mouse.move(point.x, point.y);
}

const hoverNames = (page: Page) => page.locator(".card-hover-row > span:first-child");
const hoverValues = (page: Page) => page.locator(".card-hover-row > span:last-child");
const rankedTraces = (): HoverTrace[] => [
  ...Array.from({ length: 6 }, (_, i) => ({
    id: String(i),
    points: [[0, i * 10], [100, 100 + i * 10]] as [number, number][],
  })),
  { id: "empty", name: "No measurements", points: [] },
  { id: "remote", name: "Outside crossing", points: [[0, 200], [20, 220]] },
];

test("vertical popup ranks four distinct runs by pointer Y at unchanged X and stays compact", async ({ page }, info) => {
  await crossingFixture(page, rankedTraces());
  await moveCrossingPointer(page, 50, 52);
  await expect(hoverNames(page)).toHaveText(["Run 0", "Run 1", "Run 2", "Run 3"]);
  await expect(page.locator(".card-hover-more")).toHaveCount(0);
  await expect(page.locator(".card-legend")).toBeHidden();
  await expect(page.locator(".card-hover")).not.toContainText(/train\/loss|No measurements|Outside crossing|—/);
  const before = await snapshot(page);
  await moveCrossingPointer(page, 50, 98);
  await expect(hoverNames(page)).toHaveText(["Run 5", "Run 4", "Run 3", "Run 2"]);
  expect((await snapshot(page)).pins).toEqual(before.pins);
  expect((await snapshot(page)).viewport).toEqual(before.viewport);

  await page.setViewportSize({ width: 390, height: 844 });
  await moveCrossingPointer(page, 50, 98);
  await expect(hoverNames(page)).toHaveText(["Run 5", "Run 4", "Run 3", "Run 2"]);
  const bounds = await page.locator(".card-hover").evaluate((node) => ({
    width: node.clientWidth, height: node.clientHeight,
    scrollWidth: node.scrollWidth, scrollHeight: node.scrollHeight,
  }));
  expect(bounds.width).toBeLessThanOrEqual(330);
  expect(bounds.height).toBeLessThanOrEqual(125);
  expect(bounds.scrollWidth).toBe(bounds.width);
  expect(bounds.scrollHeight).toBe(bounds.height);
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(390);
  await info.attach("nearest-crossing-compact", {
    body: await page.locator(".chart-card").screenshot({ path: info.outputPath("nearest-crossing-compact.png") }),
    contentType: "image/png",
  });
});

test("C and toolbar orientation rank horizontal crossings by pointer X at unchanged Y", async ({ page }) => {
  await crossingFixture(page, rankedTraces());
  await moveCrossingPointer(page, 27, 75);
  await page.keyboard.press("c");
  await expect(page.locator(".uplot")).toHaveAttribute("data-cursor-placement", "vertical");
  await page.keyboard.press("c");
  await expect(page.locator(".uplot")).toHaveAttribute("data-cursor-placement", "horizontal");
  await moveCrossingPointer(page, 27, 75);
  await expect(hoverNames(page)).toHaveText(["Run 5", "Run 4", "Run 3", "Run 2"]);
  await expect(page.locator(".card-hover-more")).toHaveCount(0);
  await moveCrossingPointer(page, 73, 75);
  await expect(hoverNames(page)).toHaveText(["Run 0", "Run 1", "Run 2", "Run 3"]);
  await expect(page.locator(".card-hover")).not.toContainText(/train\/loss|No measurements|Outside crossing|—/);
  const before = await snapshot(page);
  await page.getByRole("button", { name: "Add vertical cursor", exact: true }).click();
  await moveCrossingPointer(page, 50, 98);
  await expect(hoverNames(page)).toHaveText(["Run 5", "Run 4", "Run 3", "Run 2"]);
  await page.getByRole("button", { name: "Add horizontal cursor", exact: true }).click();
  await moveCrossingPointer(page, 73, 75);
  await expect(hoverNames(page)).toHaveText(["Run 0", "Run 1", "Run 2", "Run 3"]);
  expect((await snapshot(page)).pins).toEqual(before.pins);
  expect((await snapshot(page)).viewport).toEqual(before.viewport);
});

test("multi-metric popup groups by underlying run ID, not name, and selects nearest Y on each side", async ({ page }) => {
  await crossingFixture(page, [
    ...[20, 40, 60, 80].map((value, index) => ({
      id: "aggregate", name: "Shared run name", key: `metric/${index}`,
      points: [[0, value], [100, value]] as [number, number][],
    })),
    { id: "other", name: "Shared run name", key: "metric/0", points: [[0, 50], [100, 50]] },
    { id: "third", name: "Third run", key: "metric/0", points: [[0, 110], [100, 110]] },
  ]);
  await moveCrossingPointer(page, 50, 56);
  await expect(hoverNames(page)).toHaveText(["Shared run name", "Shared run name", "Third run"]);
  await expect(hoverValues(page)).toHaveText(["(40, 60)", "50", "110"]);
  await expect(page.locator(".card-hover-more")).toHaveCount(0);
  await expect(page.locator(".card-hover")).not.toContainText("metric/");
  await moveCrossingPointer(page, 50, 90);
  await expect(hoverNames(page)).toHaveText(["Shared run name", "Third run", "Shared run name"]);
  await expect(hoverValues(page)).toHaveText(["80", "110", "50"]);
  await moveCrossingPointer(page, 50, 10);
  await expect(hoverValues(page)).toHaveText(["20", "50", "110"]);
});

test("horizontal popup selects nearest X on each side, orders the tuple numerically and emits one-side once", async ({ page }) => {
  await crossingFixture(page, [{
    id: "wave", name: "Oscillating run",
    points: [[0, 0], [20, 100], [40, 0], [60, 100], [80, 0]],
  }]);
  await page.getByRole("button", { name: "Add horizontal cursor", exact: true }).click();
  await moveCrossingPointer(page, 44, 50);
  await expect(hoverNames(page)).toHaveText(["Oscillating run"]);
  await expect(hoverValues(page)).toHaveText(/^\([\d.]+, [\d.]+\)$/);
  const values = (await hoverValues(page).innerText()).match(/[\d.]+/g)!.map(Number);
  expect(values[0]).toBeCloseTo(30, 0);
  expect(values[1]).toBeCloseTo(50, 0);
  await moveCrossingPointer(page, 5, 50);
  await expect(hoverValues(page)).not.toContainText(/[(),]/);
  expect(Number(await hoverValues(page).innerText())).toBeCloseTo(10, 0);
  await moveCrossingPointer(page, 95, 50);
  await expect(hoverValues(page)).not.toContainText(/[(),]/);
  expect(Number(await hoverValues(page).innerText())).toBeCloseTo(70, 0);
});

test("repeated-X XY loop uses both vertical branches and horizontal values use the X formatter", async ({ page }) => {
  await crossingFixture(page, [{
    id: "loop", name: "Loop run",
    points: [[10, 20], [10, 80], [30, 80], [30, 20], [10, 20]],
  }], { xy: true, config: { xFormat: "fixed-2", yFormat: "number" } });
  await moveCrossingPointer(page, 20, 45);
  await expect(hoverNames(page)).toHaveText(["Loop run"]);
  await expect(hoverValues(page)).toHaveText(["(20, 80)"]);
  await moveCrossingPointer(page, 20, 100);
  await expect(hoverValues(page)).toHaveText(["80"]);
  await page.getByRole("button", { name: "Add horizontal cursor", exact: true }).click();
  await moveCrossingPointer(page, 20, 45);
  await expect(hoverValues(page)).toHaveText(["(10.00, 30.00)"]);
  await moveCrossingPointer(page, 5, 45);
  await expect(hoverValues(page)).toHaveText(["10.00"]);
});


test("popup uses log pixel distance and redraw removes offscreen crossings without pointer movement", async ({ page }) => {
  await crossingFixture(page, [2, 1000, 0.1, 10000, 0.01].map((y, i) => ({
    id: String(i), points: [[1, y], [100, y]] as [number, number][],
  })), { config: { xMin: 1, yMin: 0.01, yMax: 10000, yScale: "log", yFormat: "scientific" } });
  await moveCrossingPointer(page, 50, 100);
  await expect(hoverNames(page)).toHaveText(["Run 1", "Run 0", "Run 3", "Run 2"]);
  await expect(hoverValues(page).first()).toHaveText(/1(?:\.0+)?e\+?3/);
  await page.evaluate(() => {
    const card = (window as any).geometry.card;
    card.plot.showView({ x: [1, 100], y: [1, 200] });
  });
  await expect(hoverNames(page)).toHaveText(["Run 0"]);
  await page.getByText("Show legend", { exact: true }).click();
  await expect(page.locator(".card-legend-item")).toHaveCount(5); // Global, not viewport eligibility.
});

test("folded legend removes empty, log-excluded and no-line series but keeps valid marker-only data", async ({ page }) => {
  await crossingFixture(page, [
    { id: "visible", points: [[1, 2], [100, 2]] },
    { id: "empty", points: [] },
    { id: "log-excluded", points: [[1, -2], [100, -1]] },
  ], { config: { xMin: 1, yMin: 1, yMax: 10, yScale: "log" } });
  await page.getByText("Show legend", { exact: true }).click();
  await expect(page.locator(".card-legend-item")).toHaveCount(1);
  await expect(page.locator(".card-legend-name")).toHaveText("Run visible");
  await page.evaluate(() => {
    const card = (window as any).geometry.card;
    card.setSpec({ ...card.spec, config: { ...card.spec.config,
      style: { ...card.spec.config.style, width: 0, fill: 0, points: false },
    } });
  });
  await expect(page.locator(".card-legend-item")).toHaveCount(0);
  await page.evaluate(() => {
    const card = (window as any).geometry.card;
    card.setSpec({ ...card.spec, config: { ...card.spec.config,
      style: { ...card.spec.config.style, points: true },
    } });
  });
  await expect(page.locator(".card-legend-item")).toHaveCount(1);
  await moveCrossingPointer(page, 50, 2);
  await expect(hoverNames(page)).toHaveCount(0); // No line between markers.
  await moveCrossingPointer(page, 1, 2);
  await expect(hoverNames(page)).toHaveText(["Run visible"]);
});

test("record paired groups aggregate by run identity and keep repeated-X branches without metric suffixes", async ({ page }) => {
  await fixture(page);
  await page.evaluate(() => {
    const s = (window as any).geometry;
    const runs = ["a", "b", "empty"].map((id) => ({
      ...s.context.catalog.runs[0], id, name: id === "empty" ? "Missing pair" : `Alias ${id}`,
      rx: { sourceId: "rx:test", uid: id },
    }));
    s.context = {
      ...s.context, catalog: { ...s.context.catalog, runs }, selectedRunIds: runs.map((r) => r.id),
      api: { async post() { return {
        diagnostics: { scanned: 10, matched: 10, partial: false, reasons: [] },
        traces: [
          { run_uid: "a", y: "metrics.loss", group: 1, group_label: "1", points: [[10, 20], [30, 20], [30, 80], [10, 80], [10, 20]] },
          { run_uid: "a", y: "metrics.loss", group: "1", group_label: "1", points: [[10, 5], [30, 5]] },
          { run_uid: "a", y: "metrics.other", group: null, points: [[10, 100], [30, 100]] },
          { run_uid: "b", y: "metrics.loss", group: null, points: [[10, 45], [30, 45]] },
        ],
      }; } },
    };
    s.card.setContext(s.context);
    s.card.setSpec({ ...s.card.spec,
      records: { sourceId: "rx:test", runUids: [], x: "epoch", ys: ["metrics.loss", "metrics.other"], group: "phase", filters: { any: false, conditions: [] } },
      config: { ...s.card.spec.config, xMin: 0, xMax: 40, yMin: 0, yMax: 120 },
    });
  });
  await expect.poll(() => page.evaluate(() => (window as any).geometry.card.data.length)).toBe(4);
  await moveCrossingPointer(page, 20, 50);
  await expect(hoverNames(page)).toHaveText(["Alias b", "Alias a"]);
  await expect(hoverValues(page)).toHaveText(["45", "(20, 80)"]);
  await expect(page.locator(".card-hover")).not.toContainText(/metrics|phase|Missing pair/);
  await page.getByText("Show legend", { exact: true }).click();
  await expect(page.locator(".card-legend-item")).toHaveCount(4);
  await page.getByRole("button", { name: "Add horizontal cursor", exact: true }).click();
  await moveCrossingPointer(page, 20, 50);
  await expect(hoverNames(page)).toHaveText(["Alias a"]);
  await expect(hoverValues(page)).toHaveText(["(10, 30)"]);
});

test("moving axis ticks show both mouse coordinates, suppress overlapping labels and restore them on leave", async ({ page }, info) => {
  await crossingFixture(page, rankedTraces(), { config: { xFormat: "fixed-2", yFormat: "scientific" } });
  await moveCrossingPointer(page, 50, 75);
  const xTick = page.locator(".mouse-axis-tick-x"), yTick = page.locator(".mouse-axis-tick-y");
  await expect(xTick).toBeVisible();
  await expect(yTick).toBeVisible();
  await expect(xTick).toHaveText("50.00");
  await expect(yTick).toHaveText(/7\.500e\+?1/);
  expect(await xTick.evaluate((node) => getComputedStyle(node).pointerEvents)).toBe("none");
  const read = () => page.evaluate(() => {
    const u = (window as any).geometry.card.plot.chart;
    return [0, 1].map((i) => u.axes[i].values(u, i === 0 ? [25, 50, 75] : [25, 75, 125], i, 50, 25));
  });
  const covered = await read();
  expect(covered[0][1]).toBe("");
  expect(covered[1][1]).toBe("");
  await page.keyboard.press("c");
  await page.keyboard.press("c");
  await expect(xTick).toHaveText("50.00");
  await expect(yTick).toHaveText(/7\.500e\+?1/);
  await moveCrossingPointer(page, 85, 130);
  const moved = await read();
  expect(moved[0][1]).not.toBe("");
  expect(moved[1][1]).not.toBe("");
  await info.attach("moving-axis-ticks", {
    body: await page.locator(".chart-card").screenshot({ path: info.outputPath("moving-axis-ticks.png") }), contentType: "image/png",
  });
  await page.mouse.move(0, 0);
  await expect(xTick).toBeHidden();
  await expect(yTick).toBeHidden();
  const restored = await read();
  expect(restored[0].every((value: string) => value !== "")).toBe(true);
  expect(restored[1].every((value: string) => value !== "")).toBe(true);
});

test("horizontal repeated-X traces rank by reversed logarithmic X distance and keep X formatting", async ({ page }) => {
  await crossingFixture(page, [2, 1000, 0.1, 10000, 0.01].map((x, i) => ({
    id: String(i), points: [[x, 0], [x, 100]] as [number, number][],
  })), { xy: true, config: {
    xMin: 0.01, xMax: 10000, xScale: "log", xFormat: "scientific", yFormat: "fixed-2",
    advanced: { scales: { x: { dir: -1 }, y: { dir: -1 } } },
  } });
  await page.getByRole("button", { name: "Add horizontal cursor", exact: true }).click();
  await moveCrossingPointer(page, 100, 50);
  await expect(hoverNames(page)).toHaveText(["Run 1", "Run 0", "Run 3", "Run 2"]);
  await expect(hoverValues(page).first()).toHaveText(/1(?:\.0+)?e\+?3/);
  await expect(page.locator(".mouse-axis-tick-x")).toHaveText(/1(?:\.0+)?e\+?2/);
  await expect(page.locator(".mouse-axis-tick-y")).toHaveText("50.00");
  await page.evaluate(() => (window as any).geometry.card.plot.showView({ x: [1, 200], y: [0, 150] }));
  await expect(hoverNames(page)).toHaveText(["Run 0"]);
});

test("stationary mouse readouts recompute against the live plot rectangle after resize", async ({ page }) => {
  await crossingFixture(page, rankedTraces(), { config: { xFormat: "fixed-2", yFormat: "fixed-2" } });
  await moveCrossingPointer(page, 50, 52);
  const client = await page.evaluate(() => {
    const u = (window as any).geometry.card.plot.chart, r = u.over.getBoundingClientRect();
    return [r.left + u.valToPos(50, "x"), r.top + u.valToPos(52, "y")];
  });
  await page.evaluate(() => {
    const c = (window as any).geometry.card;
    c.setSpec({ ...c.spec, layout: { width: 820, height: 500 } });
  });
  await expect(page.locator(".mouse-axis-tick-x")).not.toHaveText("50.00");
  const expected = await page.evaluate(([x, y]) => {
    const u = (window as any).geometry.card.plot.chart, r = u.over.getBoundingClientRect();
    return [u.posToVal(x - r.left, "x").toFixed(2), u.posToVal(y - r.top, "y").toFixed(2)];
  }, client);
  await expect(page.locator(".mouse-axis-tick-x")).toHaveText(expected[0]);
  await expect(page.locator(".mouse-axis-tick-y")).toHaveText(expected[1]);
  await expect(hoverNames(page)).toHaveCount(4);
  await expect(hoverValues(page)).not.toHaveText(["50.00", "60.00", "70.00", "80.00"]);
});


test("automatic markers contribute crossings only when the live renderer draws them", async ({ page }) => {
  await crossingFixture(page, [{ id: "dense", points: Array.from({ length: 1001 }, (_, x) => [x, 10] as [number, number]) }], {
    config: { xMin: 0, xMax: 1000, yMin: 0, yMax: 20,
      style: { width: 0, fill: 0, markers: { show: "auto", size: 5, space: 10 } } },
  });
  await moveCrossingPointer(page, 500, 10);
  await expect(hoverNames(page)).toHaveCount(0);
  await page.getByText("Show legend", { exact: true }).click();
  await expect(page.locator(".card-legend-name")).toHaveText("Run dense");
  await page.evaluate(() => (window as any).geometry.card.plot.showView({ x: [495, 505], y: [0, 20] }));
  await moveCrossingPointer(page, 500, 10);
  await expect(hoverNames(page)).toHaveText(["Run dense"]);
  await expect(hoverValues(page)).toHaveText(["10"]);
  await page.evaluate(() => (window as any).geometry.card.plot.showView({ x: [0, 1000], y: [0, 20] }));
  await moveCrossingPointer(page, 500, 10);
  await expect(hoverNames(page)).toHaveCount(0);
});

test("smoothed lines do not report suppressed automatic raw markers as extra neighbors", async ({ page }) => {
  await crossingFixture(page, [{ id: "smooth", points: Array.from({ length: 1001 }, (_, x) => [x, x === 500 ? 10 : 0] as [number, number]) }], {
    config: { xMin: 0, xMax: 1000, yMin: 0, yMax: 20, smoothing: true,
      style: { markers: { show: "auto", size: 5, space: 10 } } },
  });
  await moveCrossingPointer(page, 500, 5);
  await expect(hoverNames(page)).toHaveText(["Run smooth"]);
  await expect(hoverValues(page)).not.toContainText("(");
  await expect(hoverValues(page)).not.toHaveText(["10"]);
});

test("moving ticks honor advanced axis notation and restore ordinary labels", async ({ page }) => {
  await crossingFixture(page, rankedTraces(), { config: {
    xFormat: "number", yFormat: "number",
    advanced: { axes: [{ values: "scientific" }, { values: "fixed-2" }] },
  } });
  await moveCrossingPointer(page, 50, 75);
  await expect(page.locator(".mouse-axis-tick-x")).toHaveText("5.000e+1");
  await expect(page.locator(".mouse-axis-tick-y")).toHaveText("75.00");
  const read = () => page.evaluate(() => {
    const u = (window as any).geometry.card.plot.chart;
    return [u.axes[0].values(u, [50], 0, 50, 25), u.axes[1].values(u, [75], 1, 50, 25)];
  });
  expect(await read()).toEqual([[""], [""]]);
  await page.mouse.move(0, 0);
  await expect(page.locator(".mouse-axis-tick-x")).toBeHidden();
  await expect(page.locator(".mouse-axis-tick-y")).toBeHidden();
  expect(await read()).toEqual([["5.000e+1"], ["75.00"]]);
});

test("many selected missing-field runs keep late multi-metric source identities without a legend ceiling", async ({ page }) => {
  const traces: HoverTrace[] = Array.from({ length: 70 }, (_, i) => ({
    id: String(i), points: i < 64 ? [] : [[0, i], [100, i]],
  }));
  for (let i = 64; i < 70; i++) traces.push({ id: String(i), key: "other/value", points: [[0, i + 0.4], [100, i + 0.4]] });
  await crossingFixture(page, traces);
  await moveCrossingPointer(page, 50, 67.1);
  await expect(hoverNames(page)).toHaveText(["Run 67", "Run 66", "Run 68", "Run 65"]);
  await expect(page.locator(".card-hover")).not.toContainText(/loss|other|more/);
  await page.getByText("Show legend", { exact: true }).click();
  await expect(page.locator(".card-legend-item")).toHaveCount(12);
  await moveCrossingPointer(page, 50, 69.2);
  await expect(hoverNames(page)).toHaveText(["Run 69", "Run 68", "Run 67", "Run 66"]);
});

test.describe("default crosshair orientation", () => {
  test.use({ hasTouch: true });
  for (const exit of ["toggle", "keyboard", "complete pair", "clear", "touch navigation"]) {
    test(`default popup matches vertical crossings after horizontal ${exit}`, async ({ page }) => {
      await crossingFixture(page, [{ id: "loop", name: "Loop run",
        points: [[10, 20], [10, 80], [30, 80], [30, 20], [10, 20]],
      }], { xy: true, config: { xFormat: "fixed-2", yFormat: "number" } });
      const horizontal = page.getByRole("button", { name: "Add horizontal cursor", exact: true });
      await horizontal.click();
      await moveCrossingPointer(page, 20, 45);
      await expect(hoverValues(page)).toHaveText(["(10.00, 30.00)"]);
      if (exit === "toggle") await horizontal.click();
      else if (exit === "keyboard") await page.keyboard.press("c");
      else if (exit === "touch navigation") {
        await page.getByRole("button", { name: "Touch navigation: drag to inspect, two fingers to pan and pinch to zoom", exact: true }).click();
      } else {
        for (const y of [30, 70]) {
          await moveCrossingPointer(page, 20, y);
          await page.mouse.down();
          await page.mouse.up();
        }
        if (exit === "clear") await page.getByRole("button", { name: "Clear cursors", exact: true }).click();
      }
      await expect(horizontal).toHaveAttribute("aria-pressed", "false");
      await moveCrossingPointer(page, 20, 45);
      await expect(hoverValues(page)).toHaveText(["(20, 80)"]);
      await moveCrossingPointer(page, 20, 100);
      await expect(hoverNames(page)).toHaveText(["Loop run"]);
      await expect(hoverValues(page)).toHaveText(["80"]);
      const before = await snapshot(page);
      await page.getByRole("button", { name: "Add vertical cursor", exact: true }).click();
      await moveCrossingPointer(page, 20, 100);
      await expect(hoverValues(page)).toHaveText(["80"]);
      expect((await snapshot(page)).pins).toEqual(before.pins);
      expect((await snapshot(page)).viewport).toEqual(before.viewport);
    });
  }
});
