import { test, expect, type Page } from "@playwright/test";

test.use({ hasTouch: true });
const colors = [
  "#c12345",
  "#12b678",
  "#7845cd",
  "#c29412",
  "#1177aa",
  "#bb66cc",
];
const name = (i: number) => `Run ${i} ${"long experiment name ".repeat(8)}`;
async function fixture(page: Page, mobile = false) {
  await page.setViewportSize(
    mobile ? { width: 430, height: 850 } : { width: 1200, height: 950 },
  );
  await page.route(/^http:\/\/127\.0\.0\.1:[0-9]+\/$/, (route) =>
    route.fulfill({
      contentType: "text/html",
      body: '<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><body></body>',
    }),
  );
  await page.goto("/");
  await page.evaluate(
    async ({ mobile, colors, names }) => {
      const { ChartCard } = await import("/src/cards.ts");
      const { newChart, resolveSources } = await import("/src/workspace.ts");
      document.body.style.cssText =
        "margin:12px;background:#191c20;color:#ddd;font:13px system-ui;--surface:#202429;--surface-raised:#252a30;--border:#42474e;--text:#ddd;--muted:#aaa;--control-border:#555;--accent:#7dd3fc;--selected:#304557";
      const host = document.createElement("div");
      host.style.cssText = `width:${mobile ? 390 : 1000}px;max-width:100%`;
      document.body.append(host);
      const runs = names.map((name, i) => ({
        id: String(i),
        name,
        experiment_id: "e",
        status: "finished",
        params: {},
        tags: {},
        created_at: 0,
        updated_at: 0,
      }));
      const refs = runs.map((run) => ({
        runId: run.id,
        key: "loss",
        kind: "metric",
      }));
      const catalog = {
        experiments: [],
        runs,
        series: refs.map((r) => ({
          run_id: r.runId,
          key: r.key,
          kind: r.kind,
          count: 3,
          last_step: 100,
          last_timestamp: 100,
          last_value: 100,
        })),
      };
      const spec = newChart("timeseries", ["loss"], "Legend position");
      spec.source = { mode: "explicit", series: refs };
      spec.layout = { width: mobile ? 390 : 1000, height: 480 };
      Object.assign(spec.config, {
        xMin: 0,
        xMax: 100,
        yMin: 0,
        yMax: 100,
        interpolation: "linear",
      });
      resolveSources(
        spec,
        runs.map((r) => r.id),
        catalog,
      ).forEach(
        (r, i) =>
          (spec.config.runs[r.id] = { color: colors[i], path: "linear" }),
      );
      const context = {
        api: {},
        catalog,
        selectedRunIds: runs.map((r) => r.id),
        store: {
          clear() {},
          async load() {
            return [0, 50, 100].map((value, seq) => ({
              seq,
              step: value,
              timestamp: value,
              value,
            }));
          },
        },
      };
      const card = new ChartCard(host, spec, context, {
        onEdit() {},
        onDuplicate() {},
        onRemove() {},
        onMove() {},
        onResize() {},
      });
      (window as any).legendFixture = { card, host, spec, context };
    },
    { mobile, colors, names: colors.map((_, i) => name(i)) },
  );
  await expect(page.locator(".u-over")).toBeVisible();
  await page.evaluate(() => {
    document.querySelector<HTMLElement>(".card-clipping")!.textContent =
      "Central 98% - display clipped";
  });
}
const popup = (page: Page) => page.locator(".card-hover");
const side = (page: Page) =>
  popup(page).evaluate((el) => (el as HTMLElement).dataset.side ?? "right");
async function prime(page: Page) {
  await page.evaluate(async () => {
    await new Promise(requestAnimationFrame);
    await new Promise(requestAnimationFrame);
  });
  const over = (await page.locator(".u-over").boundingBox())!;
  await page.mouse.move(over.x + over.width / 2, over.y + over.height * 0.7);
  await expect(popup(page).locator(".card-hover-row")).toHaveCount(4);
  await expect.poll(() => side(page)).toBe("right");
  return { over, box: (await popup(page).boundingBox())! };
}
async function contents(page: Page) {
  return popup(page)
    .locator(".card-hover-row")
    .evaluateAll((rows) =>
      rows.map((row) => ({
        name: row.children[0].textContent,
        title: row.querySelector<HTMLElement>(".card-series-label")!.title,
        color: getComputedStyle(row.children[0]).color,
        value: row.children[1].textContent,
      })),
    );
}
async function checkContents(page: Page) {
  const rows = await contents(page);
  expect(rows.map((row) => row.name)).toEqual(
    colors.slice(0, 4).map((_, i) => name(i)),
  );
  expect(rows.map((row) => row.title)).toEqual(rows.map((row) => row.name));
  expect(rows.map((row) => row.color)).toEqual([
    "rgb(193, 35, 69)",
    "rgb(18, 182, 120)",
    "rgb(120, 69, 205)",
    "rgb(194, 148, 18)",
  ]);
  expect(
    rows.every((row) => row.value && Number.isFinite(Number(row.value))),
  ).toBe(true);
}

for (const axis of ["vertical", "horizontal"]) {
  test(`${axis}: approach, jitter, release, and current-left escape preserve nearest four`, async ({
    page,
  }) => {
    await fixture(page);
    await page
      .getByRole("button", { name: `Add ${axis} cursor`, exact: true })
      .click();
    const { over, box } = await prime(page);
    const y = Math.max(over.y + 2, box.y + box.height / 2);
    await page.mouse.move(box.x - 14, y);
    await expect.poll(() => side(page)).toBe("right");
    await page.mouse.move(box.x - 11, y);
    await expect.poll(() => side(page)).toBe("left");
    await checkContents(page);
    for (const distance of [13, 17, 23, 14, 27]) {
      await page.mouse.move(box.x - distance, y);
      await expect.poll(() => side(page)).toBe("left");
    }
    await page.mouse.move(box.x - 30, y);
    await expect.poll(() => side(page)).toBe("right");
    await page.mouse.move(box.x + 20, y);
    await expect.poll(() => side(page)).toBe("left");
    const left = (await popup(page).boundingBox())!;
    await page.mouse.move(left.x + left.width - 5, y);
    await expect.poll(() => side(page)).toBe("right");
    await checkContents(page);
    await page.mouse.move(2, 2);
    await expect(popup(page)).toBeHidden();
  });
}

test("resized/maximized cards and clipping offsets use the current measured bounds", async ({
  page,
}) => {
  await fixture(page);
  for (const width of [900, 660]) {
    await page.evaluate((width) => {
      const f = (window as any).legendFixture;
      f.host.style.width = `${width}px`;
      f.spec.layout.width = width;
      f.card.applyDimensions();
    }, width);
    await expect
      .poll(async () =>
        Math.round((await page.locator(".chart-card").boundingBox())!.width),
      )
      .toBe(width);
    const { over, box } = await prime(page);
    await page.mouse.move(
      box.x + box.width - 20,
      Math.max(over.y + 2, box.y + box.height / 2),
    );
    await expect.poll(() => side(page)).toBe("left");
  }
  await page
    .getByRole("button", { name: "Maximize chart", exact: true })
    .click();
  const { over, box } = await prime(page);
  await page.mouse.move(
    box.x + 20,
    Math.max(over.y + 2, box.y + box.height / 2),
  );
  await expect.poll(() => side(page)).toBe("left");
  await checkContents(page);
  // A clipping notice can move the plot without changing its own dimensions.
  await page.evaluate(() => {
    document.querySelector<HTMLElement>(".card-clipping")!.style.height =
      "75px";
  });
  await prime(page);
  const actual = (await popup(page).boundingBox())!;
  const plot = (await page.locator(".u-over").boundingBox())!;
  await expectInsidePlot(page);
  await page.mouse.move(
    actual.x + actual.width - 20,
    actual.y + actual.height / 2,
  );
  await expect.poll(() => side(page)).toBe("left");
  await expectInsidePlot(page);
  await page.mouse.move(plot.x + plot.width / 2, plot.y + plot.height * 0.7);
  await expect.poll(() => side(page)).toBe("right");
});

test("narrow touch: dodge, retain contents, and do not oscillate in overlapping corners", async ({
  page,
  context,
}) => {
  await fixture(page, true);
  await page
    .getByRole("button", {
      name: "Touch navigation: drag to inspect, two fingers to pan and pinch to zoom",
      exact: true,
    })
    .click();
  const cdp = await context.newCDPSession(page);
  const over = (await page.locator(".u-over").boundingBox())!;
  const point = { id: 1, x: over.x + over.width - 3, y: over.y + 4 };
  await cdp.send("Input.dispatchTouchEvent", {
    type: "touchStart",
    touchPoints: [point],
  });
  await expect.poll(() => side(page)).toBe("right");
  await cdp.send("Input.dispatchTouchEvent", {
    type: "touchEnd",
    touchPoints: [],
  });
  await expect(popup(page).locator(".card-hover-row")).toHaveCount(4);
  await checkContents(page);
  const content = (await page.locator(".card-content").boundingBox())!;
  const left = (await popup(page).boundingBox())!;
  expect(left.x).toBeGreaterThanOrEqual(content.x);
  expect(left.x + left.width).toBeLessThanOrEqual(content.x + content.width);
  point.x = over.x + over.width / 2;
  await cdp.send("Input.dispatchTouchEvent", {
    type: "touchStart",
    touchPoints: [point],
  });
  for (let i = 0; i < 10; i++) {
    await cdp.send("Input.dispatchTouchEvent", {
      type: "touchMove",
      touchPoints: [{ ...point, x: point.x + (i % 2) }],
    });
    await expect.poll(() => side(page)).toBe("right");
  }
  point.y = over.y + over.height * 0.7;
  await cdp.send("Input.dispatchTouchEvent", {
    type: "touchMove",
    touchPoints: [point],
  });
  await expect.poll(() => side(page)).toBe("right");
  await cdp.send("Input.dispatchTouchEvent", {
    type: "touchEnd",
    touchPoints: [],
  });
  await page.screenshot({ path: test.info().outputPath("narrow-touch.png") });
});

test("cached pointer updates do not read layout and observers detach on rebuild/destroy", async ({
  page,
}) => {
  await fixture(page);
  await prime(page);
  const result = await page.evaluate(() => {
    const f = (window as any).legendFixture,
      position = f.card.hoverPosition;
    const original = Element.prototype.getBoundingClientRect;
    let reads = 0;
    Element.prototype.getBoundingClientRect = function () {
      reads++;
      return original.call(this);
    };
    try {
      for (let i = 0; i < 100; i++) position.update([i * 6, 10]);
    } finally {
      Element.prototype.getBoundingClientRect = original;
    }
    let disconnected = 0;
    for (const observer of [position.resize, position.mutation]) {
      const disconnect = observer.disconnect.bind(observer);
      observer.disconnect = () => {
        disconnected++;
        disconnect();
      };
    }
    f.card.setSpec({
      ...f.spec,
      source: { ...f.spec.source, series: f.spec.source.series.slice(0, 5) },
    });
    const replaced = f.card.hoverPosition !== position;
    f.card.destroy();
    return {
      reads,
      disconnected,
      replaced,
      connected: f.host.querySelector(".chart-card") !== null,
    };
  });
  expect(result).toEqual({
    reads: 0,
    disconnected: 2,
    replaced: true,
    connected: false,
  });
});

test("stationary and fresh touch crosshairs use the resized corners", async ({
  page,
  context,
}) => {
  await fixture(page, true);
  await popup(page).evaluate((el: HTMLElement) => {
    el.style.width = "150px";
  });
  await page.setViewportSize({ width: 1200, height: 950 });
  await page
    .getByRole("button", {
      name: "Touch navigation: drag to inspect, two fingers to pan and pinch to zoom",
      exact: true,
    })
    .click();
  const cdp = await context.newCDPSession(page);
  const over = (await page.locator(".u-over").boundingBox())!;
  await cdp.send("Input.dispatchTouchEvent", {
    type: "touchStart",
    touchPoints: [{ id: 1, x: over.x + over.width - 3, y: over.y + 4 }],
  });
  await cdp.send("Input.dispatchTouchEvent", {
    type: "touchEnd",
    touchPoints: [],
  });
  await expect.poll(() => side(page)).toBe("left");
  await page.evaluate(() => {
    const f = (window as any).legendFixture;
    f.host.style.width = "900px";
    f.spec.layout.width = 900;
    f.card.applyDimensions();
  });
  // Resize can briefly hide/re-publish hover while uPlot settles its new size.
  await expect
    .poll(async () => (await page.locator(".u-over").boundingBox())!.width)
    .toBeGreaterThan(700);
  await expect(popup(page).locator(".card-hover-row")).toHaveCount(4);
  await expect.poll(() => side(page)).toBe("right");
  await checkContents(page);
  const resized = (await page.locator(".u-over").boundingBox())!;
  await cdp.send("Input.dispatchTouchEvent", {
    type: "touchStart",
    touchPoints: [
      { id: 1, x: resized.x + resized.width - 3, y: resized.y + 4 },
    ],
  });
  await expect.poll(() => side(page)).toBe("left");
  await checkContents(page);
  await cdp.send("Input.dispatchTouchEvent", {
    type: "touchEnd",
    touchPoints: [],
  });
});

async function expectInsidePlot(page: Page) {
  await expect
    .poll(async () => {
      const box = await popup(page).boundingBox();
      const plot = await page.locator(".u-over").boundingBox();
      return (
        !!box &&
        !!plot &&
        box.x >= plot.x &&
        box.y >= plot.y &&
        box.x + box.width <= plot.x + plot.width + 0.5 &&
        box.y + box.height <= plot.y + plot.height + 0.5
      );
    })
    .toBe(true);
  const box = (await popup(page).boundingBox())!;
  for (const tick of await page
    .locator('[data-role^="mouse-axis-tick-"]:visible')
    .all()) {
    const bounds = await tick.boundingBox();
    if (bounds)
      expect(
        bounds.x + bounds.width <= box.x ||
          bounds.x >= box.x + box.width ||
          bounds.y + bounds.height <= box.y ||
          bounds.y >= box.y + box.height,
      ).toBe(true);
  }
}

for (const mobile of [false, true]) {
  test(`popup stays inside the axes in both corners and after resize (${mobile ? "mobile" : "desktop"})`, async ({
    page,
  }) => {
    await fixture(page, mobile);
    await page.evaluate((mobile) => {
      const f = (window as any).legendFixture;
      f.host.style.width = `${mobile ? 390 : 1000}px`;
      f.spec.layout.width = mobile ? 390 : 1000;
      f.card.applyDimensions();
    }, mobile);
    await prime(page);
    await expectInsidePlot(page);
    const plot = (await page.locator(".u-over").boundingBox())!;
    await page.mouse.move(plot.x + plot.width - 10, plot.y + 20);
    await expectInsidePlot(page);
    if (!mobile) await expect.poll(() => side(page)).toBe("left");
    await page
      .locator(".chart-card")
      .screenshot({ path: test.info().outputPath("popup-inside-plot.png") });
    await page.mouse.move(plot.x + 10, plot.y + 20);
    await expectInsidePlot(page);
    await expect.poll(() => side(page)).toBe("right");
    await page.evaluate(() => {
      document.querySelector<HTMLElement>(".card-clipping")!.style.height =
        "80px";
      const f = (window as any).legendFixture;
      f.spec.layout.height = 360;
      f.card.applyDimensions();
    });
    await prime(page);
    await expectInsidePlot(page);
    await checkContents(page);
  });
}
