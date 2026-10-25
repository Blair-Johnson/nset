import { test, expect, type Page, type CDPSession } from "@playwright/test";

test.use({ hasTouch: true });
const label =
  "Touch navigation: drag to inspect, two fingers to pan and pinch to zoom";
const tool = (page: Page) =>
  page.getByRole("button", { name: label, exact: true });
type Point = { x: number; y: number; id: number };
async function touch(
  cdp: CDPSession,
  type: "touchStart" | "touchMove" | "touchEnd" | "touchCancel",
  points: Point[] = [],
) {
  await cdp.send("Input.dispatchTouchEvent", { type, touchPoints: points });
}
// Chromium's legacy WebTouch path releases the named IDs on touchEnd;
// its SyntheticPointerActions path removes omitted IDs on touchMove instead.
// Both send real browser touch input, not DOM-dispatched PointerEvents.
async function releaseContact(
  cdp: CDPSession,
  released: Point,
  remaining: Point[],
) {
  try {
    await touch(cdp, "touchEnd", [released]);
  } catch (error) {
    if (!/TouchEnd.*must not.*touch points/.test(String(error))) throw error;
    await touch(cdp, "touchMove", remaining);
  }
}
async function fixture(
  page: Page,
  log = false,
  mobile = false,
  reverse = false,
) {
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
    async ({ log, mobile, reverse }) => {
      const { ChartCard } = await import("/src/cards.ts");
      const { newChart, resolveSources } = await import("/src/workspace.ts");
      document.body.style.cssText =
        "margin:12px;min-height:3000px;background:#191c20;color:#ddd;font:13px system-ui;--surface:#202429;--surface-raised:#252a30;--border:#42474e;--text:#ddd;--muted:#aaa;--control-border:#555;--accent:#7dd3fc;--selected:#304557";
      const host = document.createElement("div");
      host.style.cssText = `width:${mobile ? 390 : 720}px;max-width:100%`;
      document.body.append(host);
      const runs = ["a", "b"].map((id) => ({
        id,
        name: `Run ${id}`,
        experiment_id: "e",
        status: "finished",
        params: {},
        tags: {},
        created_at: 0,
        updated_at: 0,
      }));
      const refs = [
        { runId: "a", key: "loss", kind: "metric" },
        { runId: "a", key: "other", kind: "metric" },
        { runId: "b", key: "loss", kind: "metric" },
      ];
      const catalog = {
        experiments: [],
        runs,
        series: refs.map((r) => ({
          run_id: r.runId,
          key: r.key,
          kind: "metric",
          count: 5,
          last_step: 100,
          last_timestamp: 100,
          last_value: 20,
        })),
      };
      const spec = newChart("timeseries", ["loss"], "Touch plot");
      spec.id = "touch";
      spec.source = { mode: "explicit", series: refs };
      spec.layout = { width: mobile ? 390 : 720, height: 480 };
      Object.assign(spec.config, {
        xMin: log ? 1 : 0,
        xMax: log ? 1000 : 100,
        yMin: log ? 1 : 0,
        yMax: log ? 1000 : 100,
        xScale: log ? "log" : "linear",
        yScale: log ? "log" : "linear",
        interpolation: "linear",
      });
      if (reverse)
        spec.config.advanced = { scales: { x: { dir: -1 }, y: { dir: -1 } } };
      const sources = resolveSources(spec, ["a", "b"], catalog);
      sources.forEach((source, index) => {
        spec.config.runs[source.id] = {
          color: ["#c12345", "#12b678", "#7845cd"][index],
          path: "linear",
        };
      });
      const context = {
        api: {},
        catalog,
        selectedRunIds: ["a", "b"],
        store: {
          clear() {},
          async load(ref: any) {
            const values =
              ref.key === "other"
                ? [65, 95, 65, 95, 65]
                : ref.runId === "b"
                  ? [35, 55, 35, 55, 35]
                  : [20, 80, 20, 80, 20];
            return values.map((value, i) => ({
              seq: i + 1,
              step: log ? 10 ** (i * 0.75) : i * 25,
              timestamp: i * 25,
              value: log ? 10 ** (value / 35) : value,
            }));
          },
        },
      };
      const state: any = { context, host };
      state.card = new ChartCard(host, spec, context, {
        onEdit() {},
        onDuplicate() {},
        onRemove() {},
        onMove() {},
        onResize() {},
      });
      (window as any).touchChart = state;
    },
    { log, mobile, reverse },
  );
  await expect(page.locator(".u-over")).toBeVisible();
}
const state = (page: Page) =>
  page.evaluate(() => {
    const c = (window as any).touchChart.card,
      n = c.plot.navigation;
    return {
      view: c.plot.viewport(),
      pins: { ...c.pins },
      active: c.activePin,
      axis: c.cursorAxis,
      mode: c.mode,
      contacts: n.contacts.size,
      history: n.snapshot().history.length,
      selection: { ...c.plot.chart.select },
    };
  });
async function plotPoint(page: Page, x = 0.5, y = 0.5, id = 1): Promise<Point> {
  const box = (await page.locator(".u-over").boundingBox())!;
  return { x: box.x + box.width * x, y: box.y + box.height * y, id };
}
async function popupColors(page: Page) {
  return page.locator(".card-hover-row").evaluateAll((rows) =>
    rows.map((row) => ({
      name: row.children[0].textContent,
      color: getComputedStyle(row.children[0]).color,
    })),
  );
}

for (const mobile of [false, true])
  test(`one-finger inspect persists and preserves cursor placement state (${mobile ? "mobile" : "desktop"})`, async ({
    page,
    context,
  }) => {
    await fixture(page, false, mobile);
    await page
      .getByRole("button", { name: "Add vertical cursor", exact: true })
      .click();
    for (const fraction of [0.2, 0.8]) {
      const p = await plotPoint(page, fraction);
      await page.mouse.click(p.x, p.y);
    }
    const before = await state(page);
    await tool(page).click();
    await expect(tool(page)).toHaveAttribute("aria-pressed", "true");
    await expect(
      page.getByRole("button", { name: "Add vertical cursor", exact: true }),
    ).toHaveAttribute("aria-pressed", "false");
    const cdp = await context.newCDPSession(page);
    let p = await plotPoint(page, 0.5, 0.35);
    await touch(cdp, "touchStart", [p]);
    for (let i = 0; i < 5; i++) {
      p = { ...p, x: p.x + 1 };
      await touch(cdp, "touchMove", [p]);
      await expect(page.locator(".card-hover-row")).toHaveCount(2);
    }
    await touch(cdp, "touchEnd");
    await page.waitForTimeout(120); // regression: legacy touchend/mouseout must not erase it
    await expect(page.locator(".card-hover-row")).toHaveCount(2);
    expect(await popupColors(page)).toContainEqual({
      name: "Run a",
      color: "rgb(18, 182, 120)",
    });
    expect(await popupColors(page)).toContainEqual({
      name: "Run b",
      color: "rgb(120, 69, 205)",
    });
    const after = await state(page);
    expect(after.view).toEqual(before.view);
    expect(after.pins).toEqual(before.pins);
    expect(after.active).toBe(before.active);
    expect(after.axis).toBe(before.axis);
    expect(after.history).toBe(before.history);
    expect(after.selection.width).toBe(0);
    expect(await page.evaluate(() => scrollY)).toBe(0);
    await tool(page).click();
    await expect(tool(page)).toHaveAttribute("aria-pressed", "false");
    const a = await plotPoint(page, 0.3, 0.3),
      b = await plotPoint(page, 0.7, 0.7);
    await page.mouse.move(a.x, a.y);
    await page.mouse.down();
    await page.mouse.move(b.x, b.y, { steps: 5 });
    await page.mouse.up();
    expect(
      (await state(page)).view.x[1] - (await state(page)).view.x[0],
    ).toBeLessThan(60);
  });

for (const [log, reverse] of [
  [false, false],
  [true, false],
  [true, true],
])
  test(`real 1\u21922\u21921 contacts pan and pinch together with anchored ${reverse ? "reversed " : ""}${log ? "log" : "linear"} axes and one undo`, async ({
    page,
    context,
  }) => {
    await fixture(page, log, false, reverse);
    await tool(page).click();
    const before = await state(page),
      cdp = await context.newCDPSession(page);
    const center = await plotPoint(page);
    const a = { ...center, x: center.x - 50, id: 1 },
      b = { ...center, x: center.x + 50, id: 2 };
    await touch(cdp, "touchStart", [a]);
    await touch(cdp, "touchMove", [a, b]);
    expect((await state(page)).contacts).toBe(2);
    const anchor = await page.evaluate(({ x, y }) => {
      const u = (window as any).touchChart.card.plot.chart,
        r = u.over.getBoundingClientRect();
      return [u.posToVal(x - r.left, "x"), u.posToVal(y - r.top, "y")];
    }, center);
    // First translate, then scale AND translate in a single dispatch.
    await touch(cdp, "touchMove", [
      { ...a, x: a.x + 10 },
      { ...b, x: b.x + 10 },
    ]);
    const aa = { ...a, x: center.x - 75 + 25, y: center.y + 15 },
      bb = { ...b, x: center.x + 75 + 25, y: center.y + 15 };
    await touch(cdp, "touchMove", [aa, bb]);
    const actual = await page.evaluate(
      ({ x, y }) => {
        const u = (window as any).touchChart.card.plot.chart,
          r = u.over.getBoundingClientRect();
        return [u.posToVal(x - r.left, "x"), u.posToVal(y - r.top, "y")];
      },
      { x: center.x + 25, y: center.y + 15 },
    );
    expect(actual[0]).toBeCloseTo(anchor[0], 6);
    expect(actual[1]).toBeCloseTo(anchor[1], 6);
    const middle = await state(page);
    for (const axis of ["x", "y"] as const) {
      const span = (v: any) =>
        log ? Math.log(v[axis][1] / v[axis][0]) : v[axis][1] - v[axis][0];
      expect(span(middle.view)).toBeCloseTo(span(before.view) / 1.5, 7);
    }
    expect(middle.selection.width).toBe(0);
    expect(middle.pins).toEqual(before.pins);
    await releaseContact(cdp, bb, [aa]);
    await expect.poll(async () => (await state(page)).contacts).toBe(1);
    await touch(cdp, "touchMove", [{ ...aa, x: aa.x + 20 }]);
    expect((await state(page)).view).toEqual(middle.view);
    await expect(page.locator(".card-hover-row").first()).toBeVisible();
    expect((await state(page)).history).toBe(0);
    // A fresh second finger rebases, rather than jumping to the original camera.
    await touch(cdp, "touchMove", [{ ...aa, x: aa.x + 20 }, bb]);
    expect((await state(page)).view).toEqual(middle.view);
    await touch(cdp, "touchEnd");
    expect((await state(page)).contacts).toBe(0);
    expect((await state(page)).history).toBe(1);
    await page
      .getByRole("button", { name: "Previous view", exact: true })
      .click();
    expect((await state(page)).view).toEqual(before.view);
  });

test("touch cancellation, unexpected lost capture, tool changes, and teardown release ownership", async ({
  page,
  context,
}) => {
  await fixture(page);
  await tool(page).click();
  const before = await state(page),
    cdp = await context.newCDPSession(page);
  const a = await plotPoint(page, 0.35),
    b = await plotPoint(page, 0.65, 0.5, 2);
  const start = async () => {
    await touch(cdp, "touchStart", [a, b]);
    await touch(cdp, "touchMove", [
      { ...a, x: a.x - 30 },
      { ...b, x: b.x + 30 },
    ]);
    expect((await state(page)).view).not.toEqual(before.view);
  };
  await start();
  await touch(cdp, "touchCancel");
  expect((await state(page)).view).toEqual(before.view);
  expect((await state(page)).contacts).toBe(0);
  await start();
  await page.evaluate(() => {
    const c = (window as any).touchChart.card,
      id = [...c.plot.navigation.contacts.keys()][0];
    c.plot.chart.over.releasePointerCapture(id);
  });
  await touch(cdp, "touchMove", [
    { ...a, x: a.x - 31 },
    { ...b, x: b.x + 31 },
  ]);
  expect((await state(page)).contacts).toBe(0);
  expect((await state(page)).view).toEqual(before.view);
  await touch(cdp, "touchEnd");
  await start();
  await page
    .getByRole("button", { name: "Add horizontal cursor", exact: true })
    .evaluate((button: HTMLButtonElement) => button.click());
  await touch(cdp, "touchEnd");
  expect((await state(page)).contacts).toBe(0);
  expect((await state(page)).view).toEqual(before.view);
  expect((await state(page)).pins).toEqual(before.pins);
  await expect(tool(page)).toHaveAttribute("aria-pressed", "false");
  await tool(page).click();
  await start();
  const restored = await page.evaluate(() => {
    const c = (window as any).touchChart.card,
      over = c.plot.chart.over,
      navigation = c.plot.navigation;
    c.destroy();
    return {
      touchAction: over.style.touchAction,
      contacts: navigation.contacts.size,
      aborted: navigation.abort.signal.aborted,
    };
  });
  await touch(cdp, "touchEnd");
  expect(restored).toEqual({ touchAction: "", contacts: 0, aborted: true });
});

test("page touch scrolling remains available outside the plot", async ({
  page,
  context,
}) => {
  await fixture(page, false, true);
  await tool(page).click();
  const cdp = await context.newCDPSession(page);
  await touch(cdp, "touchStart", [{ x: 420, y: 700, id: 1 }]);
  for (const y of [650, 550, 450, 350])
    await touch(cdp, "touchMove", [{ x: 420, y, id: 1 }]);
  await touch(cdp, "touchEnd");
  await expect.poll(() => page.evaluate(() => scrollY)).toBeGreaterThan(100);
});

test("desktop crossing popup tracks the actual representative stroke for both cursor orientations", async ({
  page,
}) => {
  await fixture(page);
  const moveTo = async (x: number, y: number) => {
    const p = await page.evaluate(
      ({ x, y }) => {
        const u = (window as any).touchChart.card.plot.chart,
          r = u.over.getBoundingClientRect();
        return {
          x: r.left + u.valToPos(x, "x"),
          y: r.top + u.valToPos(y, "y"),
        };
      },
      { x, y },
    );
    await page.mouse.move(p.x, p.y);
  };
  await moveTo(50, 65);
  expect(await popupColors(page)).toContainEqual({
    name: "Run a",
    color: "rgb(18, 182, 120)",
  });
  await moveTo(50, 20);
  expect(await popupColors(page)).toContainEqual({
    name: "Run a",
    color: "rgb(193, 35, 69)",
  });
  await page
    .getByRole("button", { name: "Add horizontal cursor", exact: true })
    .click();
  await moveTo(50, 70);
  const values = await page.locator(".card-hover-row").allTextContents();
  expect(values.some((value) => value.includes("("))).toBe(true);
  expect(await popupColors(page)).toContainEqual({
    name: "Run a",
    color: "rgb(18, 182, 120)",
  });
  // A live effective stroke change must be reflected without a palette lookup.
  await page.evaluate(() => {
    const c = (window as any).touchChart.card;
    c.spec.config.runs[c.data[1].run.id].color = "#ffe012";
    c.refreshColors();
  });
  expect(await popupColors(page)).toContainEqual({
    name: "Run a",
    color: "rgb(255, 224, 18)",
  });
});

test("editor preview exposes the same toggle and shared two-finger navigation", async ({
  page,
  context,
}) => {
  await fixture(page);
  await page.evaluate(async () => {
    const { openChartEditor } = await import("/src/chart-editor.ts");
    const s = (window as any).touchChart;
    openChartEditor({
      card: s.card.spec,
      catalog: s.context.catalog,
      selectedRunIds: ["a", "b"],
      store: s.context.store,
      api: {},
      onSave() {},
    });
  });
  const dialog = page.getByRole("dialog");
  const control = dialog.getByRole("button", { name: label, exact: true });
  const over = dialog.locator(".u-over"),
    root = dialog.locator(".uplot");
  await expect(over).toBeVisible();
  await expect(control).toHaveAttribute("aria-pressed", "false");
  const before = JSON.parse((await root.getAttribute("data-view"))!);
  await control.click();
  await expect(control).toHaveAttribute("aria-pressed", "true");
  const box = (await over.boundingBox())!,
    cdp = await context.newCDPSession(page);
  const a = { x: box.x + box.width * 0.35, y: box.y + box.height / 2, id: 1 },
    b = { ...a, x: box.x + box.width * 0.65, id: 2 };
  await touch(cdp, "touchStart", [a, b]);
  await touch(cdp, "touchMove", [
    { ...a, x: a.x - 15 },
    { ...b, x: b.x + 15 },
  ]);
  await touch(cdp, "touchEnd");
  const after = JSON.parse((await root.getAttribute("data-view"))!);
  expect(after.x[1] - after.x[0]).toBeLessThan(before.x[1] - before.x[0]);
  await control.click();
  await expect(control).toHaveAttribute("aria-pressed", "false");
  await expect(root).toHaveAttribute("data-navigation-tool", "zoom");
});

test("released touch hover dismisses on Escape or tool changes; a rebuild cancels a pinch before carrying its camera", async ({
  page,
  context,
}) => {
  await fixture(page);
  await tool(page).click();
  const cdp = await context.newCDPSession(page),
    p = await plotPoint(page);
  const inspect = async () => {
    await touch(cdp, "touchStart", [p]);
    await touch(cdp, "touchEnd");
    await expect(page.locator(".card-hover-row").first()).toBeVisible();
  };
  await inspect();
  await page.keyboard.press("Escape");
  await expect(page.locator(".card-hover-row")).toHaveCount(0);
  await inspect();
  await tool(page).tap();
  await expect(page.locator(".card-hover-row")).toHaveCount(0);
  await tool(page).tap();
  await inspect();
  await page
    .getByRole("button", { name: "Add horizontal cursor", exact: true })
    .tap();
  await expect(page.locator(".card-hover-row")).toHaveCount(0);
  await tool(page).tap();
  const before = await state(page);
  const a = { ...p, x: p.x - 40 },
    b = { ...p, x: p.x + 40, id: 2 };
  await touch(cdp, "touchStart", [a, b]);
  await touch(cdp, "touchMove", [
    { ...a, x: a.x - 20 },
    { ...b, x: b.x + 20 },
  ]);
  expect((await state(page)).view).not.toEqual(before.view);
  await page.evaluate(() => {
    const c = (window as any).touchChart.card;
    c.plot.render(c.data, c.displayConfig(), c.pins, { preserveView: true });
  });
  await touch(cdp, "touchEnd");
  const after = await state(page);
  expect(after.view).toEqual(before.view);
  expect(after.history).toBe(before.history);
  expect(after.contacts).toBe(0);
  expect(after.pins).toEqual(before.pins);
  await expect(page.locator(".card-hover-row")).toHaveCount(0);
});

test("editor navigation control follows scalar/image/scalar type transitions", async ({
  page,
}) => {
  await fixture(page);
  await page.evaluate(async () => {
    const { openChartEditor } = await import("/src/chart-editor.ts");
    const s = (window as any).touchChart;
    openChartEditor({
      card: s.card.spec,
      catalog: s.context.catalog,
      selectedRunIds: ["a", "b"],
      store: s.context.store,
      api: {},
      onSave() {},
    });
  });
  const dialog = page.getByRole("dialog");
  const control = dialog.getByRole("button", { name: label, exact: true });
  await expect(control).toBeVisible();
  await dialog.getByLabel("Plot type", { exact: true }).selectOption("image");
  await expect(control).toBeHidden();
  await dialog.getByLabel("Plot type", { exact: true }).selectOption("line");
  await expect(control).toBeVisible();
  await expect(dialog.locator(".u-over")).toBeVisible();
  await control.click();
  await expect(dialog.locator(".uplot")).toHaveAttribute(
    "data-navigation-tool",
    "navigate",
  );
});
