import { expect, test, type Page } from "@playwright/test";

type XY = [number, number];
type Scenario = {
  interpolation: "linear" | "pchip";
  base: 2 | 10;
  reversed: boolean;
  steep: boolean;
};

// A renderer-side setTimeout cannot interrupt a synchronous tick/path loop.
// This deadline runs in the Playwright worker and closes the isolated test page.
async function bounded<T>(page: Page, operation: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          void page.close({ runBeforeUnload: false }).catch(() => {});
          reject(new Error("Log rendering did not yield within 10 seconds"));
        }, 10_000);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/** Navigation's real PlotPanel fixture; no smoothing or replacement renderer. */
async function fixture(page: Page, scenario: Scenario) {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.route("**/__log_rendering_fixture", (route) =>
    route.fulfill({
      contentType: "text/html",
      body: "<!doctype html><html><body></body></html>",
    }),
  );
  await page.goto("/__log_rendering_fixture");
  await bounded(
    page,
    page.evaluate(async (scenario) => {
      const { PlotPanel } = await import("/src/plot.ts");
      const { validateConfig } = await import("/src/config.ts");
      const { makeInterpolator } = await import("/src/math.ts");
      document.body.style.cssText = "margin:0;background:white";
      const host = document.createElement("div");
      host.style.width = "900px";
      document.body.replaceChildren(host);
      const points: [number, number][] = scenario.steep
        ? [
            [1000, -1e6],
            [1000.001, 1e6],
            [1e6, 1e6 + 1],
          ]
        : [
            [1e3, 10],
            [2e3, 80],
            [1e5, 30],
            [1e6, 90],
          ];
      const s: any = {
        warnings: [],
        picks: [],
        changes: 0,
        draws: 0,
        work: { at: 0, project: 0, path: 0 },
        pins: scenario.steep
          ? { a: 1000.00049998, b: 1000.00050002, threshold: 0 }
          : { a: 2e3, b: 1e5, threshold: 50 },
        config: validateConfig({
          smoothing: false,
          interpolation: scenario.interpolation,
          xScale: "log",
          yScale: "linear",
          xMin: scenario.steep ? 900 : 1e3,
          xMax: scenario.steep ? 2000 : 1e6,
          yMin: scenario.steep ? -100 : 0,
          yMax: 100,
          height: 420,
          palette: false,
          style: {
            path: "matched",
            color: "#ff00d4",
            width: 3,
            points: false,
            fill: 0,
          },
          advanced: {
            scales: {
              x: { log: scenario.base, dir: scenario.reversed ? -1 : 1 },
            },
          },
        }),
      };
      // Fail deterministically before an accidental unbounded subdivision can hang.
      // Thresholds are deliberately generous, not microbenchmark expectations.
      s.bump = (key: "at" | "project" | "path") => {
        if (++s.work[key] > 100_000)
          throw Error(`Unbounded ${key} work: ${s.work[key]}`);
      };
      for (const method of [
        "moveTo",
        "lineTo",
        "rect",
        "bezierCurveTo",
        "quadraticCurveTo",
      ] as const) {
        const native = (Path2D.prototype as any)[method];
        (Path2D.prototype as any)[method] = function (...args: number[]) {
          s.bump("path");
          if (!args.every(Number.isFinite))
            throw Error(`Nonfinite Path2D.${method}: ${args}`);
          return native.apply(this, args);
        };
      }
      const fn = makeInterpolator(points, scenario.interpolation);
      const nativeAt = fn.at;
      fn.at = (x: number) => {
        s.bump("at");
        return nativeAt(x);
      };
      s.data = [
        {
          run: { id: "r", name: "Unsmoothed log curve" },
          points,
          observations: points.map((p) => [...p]),
          count: points.length,
          fn,
        },
      ];
      s.panel = new PlotPanel(
        host,
        (x: number) => s.picks.push(x),
        (warnings: string[]) => s.warnings.push(...warnings),
      );
      s.panel.configureInteraction({
        mode: "pan",
        axis: "x",
        activePin: "a",
        onPin: (pin: string, value: number) => {
          s.pins[pin] = value;
        },
        onViewChange: () => s.changes++,
      });
      s.panel.render(s.data, s.config, s.pins);
      const u = s.panel.chart;
      if (!u.setScale.toString().includes("Math.log10"))
        throw Error(
          "Log-range compatibility patch was not applied to the browser runtime",
        );
      const nativeProject = u.valToPos.bind(u);
      u.valToPos = (...args: any[]) => {
        s.bump("project");
        const value = nativeProject(...args);
        if (!Number.isFinite(value))
          throw Error(`Nonfinite projection: ${args}`);
        return value;
      };
      u.hooks.draw.push(() => {
        s.draws++;
      });
      s.resetWork = () => {
        s.work = { at: 0, project: 0, path: 0 };
      };
      s.truth = () => ({
        points: s.data[0].points,
        observations: s.data[0].observations,
        count: s.data[0].count,
        pins: s.pins,
        values: [s.pins.a, s.pins.b].map((x: number) => nativeAt(x)),
        crossings: fn.crossings(s.pins.threshold),
        picks: s.picks,
      });
      s.initialTruth = JSON.stringify(s.truth());
      s.setView = (x: [number, number]) => {
        s.resetWork();
        u.batch(() => u.setScale("x", { min: x[0], max: x[1] }));
      };
      (window as any).__logRendering = s;
    }, scenario),
  );
  await expect(page.locator(".u-over")).toBeVisible();
  await settled(page);
  return errors;
}

async function settled(page: Page) {
  return bounded(
    page,
    page.evaluate(async () => {
      const s = (window as any).__logRendering;
      await new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
      );
      const before = s.draws;
      await new Promise((resolve) => setTimeout(resolve, 120));
      return {
        idleDraws: s.draws - before,
        draws: s.draws,
        work: { ...s.work },
      };
    }),
  );
}

async function health(page: Page) {
  const idle = await settled(page);
  expect(idle.idleDraws, "idle chart must stop repainting").toBeLessThanOrEqual(
    1,
  );
  for (const count of Object.values(idle.work) as number[])
    expect(count, "bounded interpolation/projection/path work").toBeLessThan(
      50_000,
    );
  const state = await bounded(
    page,
    page.evaluate(() => {
      const s = (window as any).__logRendering,
        u = s.panel.chart;
      const canvas = u.ctx.canvas;
      const view = s.panel.viewport();
      const ticks = (u.axes[0]._splits ?? []) as number[];
      return {
        warnings: s.warnings,
        unchanged: JSON.stringify(s.truth()) === s.initialTruth,
        smoothing: s.config.smoothing,
        path: s.config.style.path,
        finite: [
          ...view.x,
          ...view.y,
          ...Object.values(u.bbox),
          canvas.width,
          canvas.height,
        ].every((n) => typeof n === "number" && Number.isFinite(n)),
        width: canvas.width,
        height: canvas.height,
        ticks,
        view,
        changes: s.changes,
      };
    }),
  );
  expect(state.finite).toBe(true);
  expect(state.width).toBeGreaterThan(0);
  expect(state.height).toBeGreaterThan(0);
  expect(state.view.x[0]).toBeGreaterThan(0);
  expect(state.view.x[1]).toBeGreaterThan(state.view.x[0]);
  expect(state.ticks.length, "log axis still renders ticks").toBeGreaterThan(0);
  expect(state.ticks.length).toBeLessThan(1000);
  expect(
    state.ticks.every(
      (x) =>
        Number.isFinite(x) &&
        x > 0 &&
        x >= state.view.x[0] &&
        x <= state.view.x[1],
    ),
  ).toBe(true);
  expect(
    state.warnings.filter((w: string) =>
      /approximation|adaptive|limit/i.test(w),
    ),
  ).toEqual([]);
  expect(
    state.unchanged,
    "raw points, observations, pins, and numerical cursor answers",
  ).toBe(true);
  expect(state.smoothing).toBe(false);
  expect(state.path).toBe("matched");
  return state;
}

async function setView(page: Page, range: XY) {
  await bounded(
    page,
    page.evaluate(
      (range) => (window as any).__logRendering.setView(range),
      range,
    ),
  );
  const state = await health(page);
  // Compare in log space: absolute tolerances would accept zero at tiny scales.
  expect(Math.log10(state.view.x[0])).toBeCloseTo(Math.log10(range[0]), 8);
  expect(Math.log10(state.view.x[1])).toBeCloseTo(Math.log10(range[1]), 8);
  return state;
}

async function panGesture(page: Page) {
  await bounded(
    page,
    page.evaluate(() => (window as any).__logRendering.resetWork()),
  );
  await bounded(
    page,
    (async () => {
      const box = (await page.locator(".u-over").boundingBox())!;
      await page.mouse.move(box.x + box.width * 0.45, box.y + box.height * 0.5);
      await page.mouse.down();
      await page.mouse.move(box.x + box.width * 0.6, box.y + box.height * 0.5, {
        steps: 5,
      });
      await page.mouse.up();
      await page.mouse.move(1200, 700);
    })(),
  );
  return health(page);
}

/** Check real stroke pixels, not path presence, marker pixels, or a screenshot baseline. */
async function curvePixels(page: Page, steep: boolean) {
  const samples = await bounded(
    page,
    page.evaluate((steep) => {
      const s = (window as any).__logRendering,
        u = s.panel.chart;
      const fn = s.data[0].fn;
      const positions: [number, number][] = steep
        ? [-80, -40, 17, 40, 80].map((y) => [fn.crossings(y).points[0], y])
        : [1500, 5000, 50000, 500000].map((x) => [x, fn.at(x)]);
      const ratio = devicePixelRatio;
      return positions.map(([x, y]) => {
        const px = u.valToPos(x, "x", true),
          py = u.valToPos(y, "y", true);
        const radius = Math.ceil(3 * ratio);
        const left = Math.max(Math.ceil(u.bbox.left), Math.floor(px) - radius);
        const top = Math.max(Math.ceil(u.bbox.top), Math.floor(py) - radius);
        const right = Math.min(
          Math.floor(u.bbox.left + u.bbox.width),
          Math.ceil(px) + radius + 1,
        );
        const bottom = Math.min(
          Math.floor(u.bbox.top + u.bbox.height),
          Math.ceil(py) + radius + 1,
        );
        let colored = 0;
        if (right > left && bottom > top) {
          const rgba = u.ctx.getImageData(
            left,
            top,
            right - left,
            bottom - top,
          ).data;
          for (let i = 0; i < rgba.length; i += 4)
            if (
              rgba[i] > 180 &&
              rgba[i + 1] < 90 &&
              rgba[i + 2] > 130 &&
              rgba[i + 3] > 100
            )
              colored++;
        }
        return {
          x,
          y,
          colored,
          edgeDistance:
            Math.min(px - u.bbox.left, u.bbox.left + u.bbox.width - px) / ratio,
        };
      });
    }, steep),
  );
  for (const sample of samples) {
    expect(
      sample.colored,
      `visible magenta curve near (${sample.x}, ${sample.y})`,
    ).toBeGreaterThan(0);
    if (steep) {
      expect(sample.edgeDistance).toBeGreaterThan(0);
      expect(sample.edgeDistance).toBeLessThan(8);
    }
  }
}

for (const interpolation of ["linear", "pchip"] as const) {
  for (const base of [2, 10] as const) {
    for (const reversed of [false, true]) {
      const label = `${interpolation}, log${base}, ${reversed ? "reversed" : "forward"}`;
      test(`unsmoothed near-vertical curve survives viewport clipping (${label})`, async ({
        page,
      }) => {
        test.setTimeout(45_000);
        const errors = await fixture(page, {
          interpolation,
          base,
          reversed,
          steep: true,
        });
        await setView(page, [999.99, 1002]);
        await curvePixels(page, true);
        const moved = await panGesture(page);
        expect(moved.changes).toBeGreaterThan(0);
        for (let i = 0; i < 3; i++) {
          await setView(page, [999.985, 1002.5]);
          await curvePixels(page, true);
          await setView(page, [999.99, 1002]);
          await curvePixels(page, true);
        }
        expect(errors).toEqual([]);
      });

      test(`unsmoothed sparse log data stays responsive in empty tiny decades (${label})`, async ({
        page,
      }) => {
        test.setTimeout(45_000);
        const errors = await fixture(page, {
          interpolation,
          base,
          reversed,
          steep: false,
        });
        await curvePixels(page, false);
        const ranges: XY[] = [
          [1e-10, 0.1],
          [1e-100, 1e-90],
          [1e-300, 1e-290],
        ];
        for (let round = 0; round < 2; round++) {
          for (const range of ranges) {
            const before = await setView(page, range);
            const after = await panGesture(page);
            expect(Math.log10(after.view.x[0])).not.toBe(
              Math.log10(before.view.x[0]),
            );
            expect(after.changes).toBeGreaterThan(before.changes);
            expect(after.view.x[1]).toBeLessThan(1e3);
            await bounded(
              page,
              page.evaluate(() => {
                const s = (window as any).__logRendering;
                s.resetWork();
                s.panel.pan(-0.1, 0);
              }),
            );
            await health(page);
            await setView(page, [1e3, 1e6]);
            await curvePixels(page, false);
          }
        }
        expect(errors).toEqual([]);
      });
    }
  }
}
