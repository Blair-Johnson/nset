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
  await page.evaluate(() => {
    const c = (window as any).geometry.card;
    c.plot.interaction.onHover(2);
  });
  await expect(page.locator(".card-hover-row")).toHaveCount(3);
  await expect(page.locator(".card-hover-more")).toHaveText("1 more in legend");
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
  await page.getByRole("spinbutton", { name: "Cursor A level" }).fill("1");
  await page.getByRole("spinbutton", { name: "Cursor A level" }).press("Tab");
  await page.getByRole("spinbutton", { name: "Cursor B level" }).fill("2");
  await page.getByRole("spinbutton", { name: "Cursor B level" }).press("Tab");
  await expect(page.locator(".card-delta-y")).toHaveText("A 1 · B 2 · Δ Y 1");
  await expect(page.locator(".card-crossings")).toHaveCount(8);
  await expect(page.locator(".card-crossings").first()).toContainText(
    "5 crossings",
  );
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
  await page.evaluate(() =>
    (window as any).geometry.card.plot.interaction.onHover(2),
  );
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
  await expect(page.locator(".card-hover-row")).toHaveCount(3);
  await expect(page.locator(".card-hover-more")).toHaveText(
    "57 more in legend",
  );
  await page.evaluate(() =>
    (window as any).geometry.card.plot.interaction.onHover(null),
  );
  await expect(page.locator(".card-legend-coordinate")).toHaveText("At step 2");
  await expect(page.locator(".card-legend-value").last()).toHaveText("2");
  await page.locator(".card-legend").focus();
  await page.keyboard.press("End");
  await expect
    .poll(() => page.locator(".card-legend").evaluate((el) => el.scrollTop))
    .toBeGreaterThan(100);
  expect(bounds.document).toBe(1500);
  await page.screenshot({ path: info.outputPath("dense-card-readouts.png") });
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

test("cursor creation returns to zoom and existing horizontal/vertical pins drag directly", async ({
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
    .toBe("zoom");
  expect((await snapshot(page)).pins.yA).toBeCloseTo(0.8, 1);
  await expect(
    page.getByRole("button", { name: "Place horizontal cursor A" }),
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

test("an armed cursor can be placed by dragging all the way to release", async ({
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
  expect((await snapshot(page)).pins.yA).toBeCloseTo(1.3, 1);
  await expect(
    page.getByRole("button", { name: "Add horizontal cursor", exact: true }),
  ).toHaveAttribute("aria-pressed", "false");
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
    await page.getByLabel("Cursor A level", { exact: true }).fill("2");
    await page.getByLabel("Cursor A level", { exact: true }).press("Tab");
    const a = page.locator(".card-crossings").filter({ hasText: "Run a" });
    const b = page.locator(".card-crossings").filter({ hasText: "Run b" });
    await a.locator("summary").click();
    await b.locator("summary").click();
    await expect(a).toContainText("5s, 15s");
    await expect(b).toContainText("6s – 8s");
    await expect(page.locator(".card-results")).not.toContainText("1970");
  });
