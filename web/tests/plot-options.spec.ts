import { test, expect, type Page } from "@playwright/test";

async function fixture(page: Page, extra: Record<string, unknown> = {}) {
  await page.goto("/");
  await page.evaluate(async (extra) => {
    // Vite serves the same source modules used by the application. No server/API
    // fixture is needed for these rendering and option-contract checks.
    const { PlotPanel } = await import("/src/plot.ts");
    const { validateConfig } = await import("/src/config.ts");
    const { makeInterpolator } = await import("/src/math.ts");
    const host = document.createElement("div");
    host.style.width = "900px";
    document.body.replaceChildren(host);
    const state: any = {
      host,
      picks: [],
      warnings: [],
      config: validateConfig({
        yScale: "log",
        style: { points: true },
        ...extra,
      }),
    };
    state.data = [
      {
        run: { id: "a", name: "First" },
        points: [
          [0, 1],
          [1, 100],
        ],
        observations: [
          [0, 1],
          [1, 100],
        ],
        count: 2,
      },
      {
        run: { id: "b", name: "Second" },
        points: [
          [0, 2],
          [1, 50],
        ],
        observations: [
          [0, 2],
          [1, 50],
        ],
        count: 2,
      },
    ].map((d) => ({ ...d, fn: makeInterpolator(d.points, "linear") }));
    state.panel = new PlotPanel(
      host,
      (x: number) => state.picks.push(x),
      (w: string[]) => (state.warnings = w),
    );
    state.panel.render(state.data, state.config, {
      a: null,
      b: null,
      threshold: null,
    });
    (window as any).__plotOptions = state;
  }, extra);
  await expect(page.locator(".u-over")).toBeVisible();
}
const state = (page: Page) =>
  page.evaluate(() => {
    const s = (window as any).__plotOptions,
      u = s.panel.chart;
    return {
      show: u.series.map((v: any) => v.show),
      x: [u.scales.x.min, u.scales.x.max],
      y: [u.scales.y.min, u.scales.y.max],
      picks: s.picks,
      value: s.data[0].fn.at(0.5),
    };
  });

test("matched nonlinear paths rebuild after zoom/resize, not comparison-grid densification", async ({
  page,
}) => {
  await fixture(page);
  const initial = await page.evaluate(() => {
    const s = (window as any).__plotOptions,
      u = s.panel.chart;
    s.calls = 0;
    const path = u.series[1].paths;
    u.series[1].paths = (...args: any[]) => {
      s.calls++;
      return path(...args);
    };
    return {
      grid: u.data[0],
      points: s.data[0].points,
      value: s.data[0].fn.at(0.5),
    };
  });
  expect(initial.grid).toEqual([0, 1]);
  expect(initial.points).toHaveLength(2);
  expect(initial.value).toBe(50.5);
  await page.evaluate(() => {
    const s = (window as any).__plotOptions;
    s.panel.chart.setScale("x", { min: 0.25, max: 0.75 });
  });
  await expect
    .poll(() => page.evaluate(() => (window as any).__plotOptions.calls))
    .toBeGreaterThan(0);
  const calls = await page.evaluate(() => (window as any).__plotOptions.calls);
  await page.evaluate(() =>
    (window as any).__plotOptions.panel.chart.setSize({
      width: 700,
      height: 500,
    }),
  );
  await expect
    .poll(() => page.evaluate(() => (window as any).__plotOptions.calls))
    .toBeGreaterThan(calls);
  expect((await state(page)).value).toBe(50.5);
});

test("legend raw/derived toggles and isolate operate on run pairs", async ({
  page,
}) => {
  await fixture(page);
  const labels = page.locator(".u-legend tbody .u-series th");
  await labels.nth(1).click();
  expect((await state(page)).show.slice(1)).toEqual([false, false, true, true]);
  await labels.nth(0).click();
  expect((await state(page)).show.slice(1)).toEqual([true, true, true, true]);
  await labels.nth(0).click({ modifiers: ["Meta"] });
  expect((await state(page)).show.slice(1)).toEqual([true, true, false, false]);
  await labels.nth(1).click({ modifiers: ["Meta"] });
  expect((await state(page)).show.slice(1)).toEqual([true, true, true, true]);
  await fixture(page, { advanced: { legend: { isolate: true } } });
  await labels.nth(0).click();
  expect((await state(page)).show.slice(1)).toEqual([true, true, false, false]);
});

test("short completed drags never set pins and setScale:false retains range", async ({
  page,
}) => {
  await fixture(page, {
    advanced: { cursor: { drag: { x: true, dist: 1, setScale: false } } },
  });
  const before = await state(page),
    box = (await page.locator(".u-over").boundingBox())!;
  const x = box.x + box.width * 0.4,
    y = box.y + box.height * 0.5;
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x + 3, y, { steps: 3 });
  await page.mouse.up();
  const after = await state(page);
  expect(after.picks).toEqual([]);
  expect(after.x).toEqual(before.x);
  await page.mouse.click(x, y);
  expect((await state(page)).picks).toHaveLength(1);
});

test("rejected config preserves active chart; singleton remains visible without raw markers", async ({
  page,
}) => {
  await fixture(page);
  const result = await page.evaluate(() => {
    const s = (window as any).__plotOptions,
      previous = s.panel.chart;
    let error = "";
    try {
      s.panel.render(
        s.data,
        { ...s.config, advanced: { hooks: {} } },
        { a: null, b: null, threshold: null },
      );
    } catch (e) {
      error = String(e);
    }
    return { same: previous === s.panel.chart, error };
  });
  expect(result.same).toBe(true);
  expect(result.error).toContain("protected");
  const singleton = await page.evaluate(async () => {
    const { makeInterpolator } = await import("/src/math.ts");
    const s = (window as any).__plotOptions,
      points = [[0.5, 10]];
    const data = [
      {
        ...s.data[0],
        points,
        observations: points,
        fn: makeInterpolator(points, "linear"),
      },
    ];
    s.panel.render(
      data,
      { ...s.config, style: { ...s.config.style, points: false } },
      { a: null, b: null, threshold: null },
    );
    const u = s.panel.chart;
    return {
      derived: u.series[1].show,
      raw: u.series[2].show,
      marker: u.series[1].points.show(u, 1, 0, 0),
    };
  });
  expect(singleton).toEqual({ derived: true, raw: false, marker: true });
});

test("cursor point literals create native markers and preserve supplied styles", async ({
  page,
}) => {
  await fixture(page, {
    advanced: {
      cursor: {
        points: {
          show: true,
          one: true,
          size: 12,
          width: 2,
          stroke: "red",
          fill: "blue",
        },
        focus: { prox: 40 },
      },
    },
  });
  await expect(page.locator(".u-cursor-pt")).toHaveCount(1);
  const marker = await page
    .locator(".u-cursor-pt")
    .evaluate((el) => ({
      width: (el as HTMLElement).style.width,
      background: (el as HTMLElement).style.background,
    }));
  expect(marker.width).toBe("12px");
});
