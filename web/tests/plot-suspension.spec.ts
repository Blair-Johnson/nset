import { expect, test, type Page } from "@playwright/test";

async function fixture(page: Page, render = true) {
  // Load production modules without the dashboard's unrelated observers/timers.
  await page.route("**/__plot-suspension", (route) =>
    route.fulfill({
      contentType: "text/html",
      body: "<!doctype html><body></body>",
    }),
  );
  await page.goto("/__plot-suspension");
  await page.evaluate(async (render) => {
    const { PlotPanel } = await import("/src/plot.ts");
    const { validateConfig } = await import("/src/config.ts");
    const { makeInterpolator } = await import("/src/math.ts");
    const s: any = {
      inputCalls: 0,
      warnings: 0,
      draws: 0,
      sizes: 0,
      listeners: [],
    };
    const add = window.addEventListener.bind(window);
    window.addEventListener = ((type: string, listener: any, options: any) => {
      if (options?.signal) {
        s.listeners.push({ type, signal: options.signal });
        const original = listener;
        listener = (event: Event) => {
          s.inputCalls++;
          return original.call(window, event);
        };
      }
      add(type, listener, options);
    }) as typeof window.addEventListener;
    const host = document.createElement("div");
    host.style.cssText = "width:900px;height:400px";
    document.body.append(host);
    s.host = host;
    s.config = validateConfig({
      xMin: 0,
      xMax: 100,
      yMin: 0,
      yMax: 100,
      height: 400,
    });
    s.pins = { a: 20, b: 80, threshold: 50, yA: 30, yB: 70 };
    s.data = (last: number) =>
      ["r1", "r2"].map((id, i) => {
        const points = [
          [1, 1 + i],
          [50, 60 + i],
          [100, last + i],
        ];
        return {
          run: { id, name: id },
          points,
          observations: points,
          count: 3,
          fn: makeInterpolator(points, "linear"),
        };
      });
    s.panel = new PlotPanel(
      host,
      () => {},
      () => s.warnings++,
    );
    s.panel.configureInteraction({
      mode: "pan",
      axis: "both",
      activePin: "a",
      directGestures: true,
    });
    if (render) s.panel.render(s.data(90), s.config, s.pins);
    s.probe = () => {
      const chart = s.panel.chart;
      chart.hooks.draw.push(() => s.draws++);
      const size = chart.setSize;
      chart.setSize = (...args: any[]) => {
        s.sizes++;
        return size(...args);
      };
    };
    (window as any).__suspend = s;
  }, render);
  if (render) {
    await expect(page.locator("canvas").first()).toBeVisible();
    await page.evaluate(() => (window as any).__suspend.probe());
  }
}

const settle = (page: Page) => page.waitForTimeout(160);

test("suspension detaches global inputs and resize, retaining canvas and complete navigation", async ({
  page,
}) => {
  await fixture(page);
  await page.evaluate(() => {
    const s = (window as any).__suspend;
    s.panel.zoom(2);
    s.panel.pan(0.1, 0.1);
    // Complete setup drawing before measuring new work during suspension.
    s.panel.chart.batch(() => s.panel.chart.setSeries(3, { show: false }));
    s.saved = {
      chart: s.panel.chart,
      navigation: s.panel.navigation,
      canvas: s.host.querySelector("canvas"),
      data: s.panel.analyzed,
      snapshot: s.panel.navigation.snapshot(),
      fit: structuredClone(s.panel.navigation.fit),
      pins: structuredClone(s.panel.pins),
    };
    s.panel.setActive(false);
    s.panel.setActive(false);
    s.inputCalls = s.draws = s.sizes = 0;
    s.host.style.width = "700px";
    window.dispatchEvent(new PointerEvent("pointermove", { buttons: 1 }));
    window.dispatchEvent(new KeyboardEvent("keydown", { code: "Space" }));
  });
  await settle(page);
  expect(
    await page.evaluate(() => {
      const s = (window as any).__suspend;
      return {
        calls: s.inputCalls,
        draws: s.draws,
        sizes: s.sizes,
        listeners: s.listeners.length,
        detached: s.listeners.every((l: any) => l.signal.aborted),
        buttons: s.panel.navigation.pointerButtons,
        space: s.panel.navigation.space,
      };
    }),
  ).toMatchObject({
    calls: 0,
    draws: 0,
    sizes: 0,
    listeners: 8,
    detached: true,
    buttons: 0,
    space: false,
  });
  await page.evaluate(() => {
    const s = (window as any).__suspend;
    s.panel.setActive(true);
    s.panel.setActive(true);
    window.dispatchEvent(new PointerEvent("pointermove", { buttons: 0 }));
  });
  await settle(page);
  expect(
    await page.evaluate(() => {
      const s = (window as any).__suspend,
        p = s.panel;
      return {
        sameChart: p.chart === s.saved.chart,
        sameNavigation: p.navigation === s.saved.navigation,
        sameCanvas: s.host.querySelector("canvas") === s.saved.canvas,
        sameData: p.analyzed === s.saved.data,
        snapshot: p.navigation.snapshot(),
        fit: p.navigation.fit,
        pins: p.pins,
        saved: {
          snapshot: s.saved.snapshot,
          fit: s.saved.fit,
          pins: s.saved.pins,
        },
        hidden: p.chart.series[3].show === false,
        width: p.chart.width,
        sizes: s.sizes,
        listeners: s.listeners.filter((l: any) => !l.signal.aborted).length,
        calls: s.inputCalls,
      };
    }),
  ).toMatchObject({
    sameChart: true,
    sameNavigation: true,
    sameCanvas: true,
    sameData: true,
    hidden: true,
    width: 700,
    sizes: 1,
    listeners: 8,
    calls: 1,
  });
  expect(
    await page.evaluate(() => {
      const s = (window as any).__suspend,
        n = s.panel.navigation;
      const retained =
        JSON.stringify(n.snapshot()) === JSON.stringify(s.saved.snapshot) &&
        JSON.stringify(n.fit) === JSON.stringify(s.saved.fit) &&
        JSON.stringify(s.panel.pins) === JSON.stringify(s.saved.pins);
      s.panel.back();
      const back = s.panel.viewport();
      s.panel.reset();
      return {
        retained,
        back:
          JSON.stringify(back) ===
          JSON.stringify(s.saved.snapshot.history.at(-1)),
        fit: JSON.stringify(s.panel.viewport()) === JSON.stringify(s.saved.fit),
      };
    }),
  ).toEqual({ retained: true, back: true, fit: true });
  await page.evaluate(() => {
    const s = (window as any).__suspend;
    s.panel.destroy();
    s.panel.setActive(true);
  });
  expect(
    await page.evaluate(() => {
      const s = (window as any).__suspend;
      return {
        canvas: s.host.querySelectorAll("canvas").length,
        listeners: s.listeners.filter((l: any) => !l.signal.aborted).length,
      };
    }),
  ).toEqual({ canvas: 0, listeners: 0 });
});

test("inactive render, color, order and pin edits coalesce into the latest view-preserving update", async ({
  page,
}) => {
  await fixture(page);
  await page.evaluate(() => {
    const s = (window as any).__suspend;
    s.panel.zoom(2);
    // Complete setup drawing before measuring new work during suspension.
    s.panel.chart.batch(() => s.panel.chart.setSeries(3, { show: false }));
    s.savedView = s.panel.viewport();
    s.savedHistory = s.panel.navigation.snapshot().history;
    s.savedChart = s.panel.chart;
    s.savedData = s.panel.analyzed;
    s.panel.setActive(false);
    s.draws = s.warnings = 0;
    s.panel.updateData(s.data(91), s.config, s.pins);
    s.panel.render(s.data(92), s.config, s.pins);
    s.latest = s.data(93);
    s.panel.updateData(s.latest, s.config, s.pins);
    s.panel.refreshColors({
      ...s.config,
      runs: { r1: { color: "#ff0000" }, r2: { color: "#00ff00" } },
    });
    s.panel.setDrawOrder(["r2", "r1"]);
    s.panel.setPins({ ...s.pins, a: 25, yA: 35 });
  });
  await settle(page);
  expect(
    await page.evaluate(() => {
      const s = (window as any).__suspend;
      return {
        draws: s.draws,
        warnings: s.warnings,
        timer: s.panel.dataTimer ?? null,
        sameChart: s.panel.chart === s.savedChart,
        sameData: s.panel.analyzed === s.savedData,
      };
    }),
  ).toEqual({
    draws: 0,
    warnings: 0,
    timer: null,
    sameChart: true,
    sameData: true,
  });
  expect(
    await page.evaluate(() => {
      const s = (window as any).__suspend;
      s.panel.setActive(true);
      return {
        latest: s.panel.analyzed === s.latest,
        warnings: s.warnings,
        camera:
          JSON.stringify(s.panel.viewport()) === JSON.stringify(s.savedView),
        history:
          JSON.stringify(s.panel.navigation.snapshot().history) ===
          JSON.stringify(s.savedHistory),
        color: s.panel.seriesColor(0),
        slots: s.panel.seriesSlots,
        hidden: s.panel.chart.series[s.panel.seriesIndex(1)].show === false,
        pins: s.panel.pins,
        pending: s.panel.pendingData ?? null,
      };
    }),
  ).toEqual({
    latest: true,
    warnings: 1,
    camera: true,
    history: true,
    color: "#ff0000",
    slots: [1, 0],
    hidden: true,
    pins: { a: 25, b: 80, threshold: 50, yA: 35, yB: 70 },
    pending: null,
  });
});

test("suspension cancels pointer capture, deferred updates and pending wheel bursts", async ({
  page,
}) => {
  await fixture(page);
  const box = (await page.locator(".u-over").boundingBox())!;
  await page.evaluate(() => {
    const s = (window as any).__suspend;
    s.panel.zoom(2);
    s.before = s.panel.viewport();
  });
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down({ button: "right" });
  await page.mouse.move(box.x + box.width * 0.7, box.y + box.height * 0.7);
  expect(
    await page.evaluate(() => {
      const s = (window as any).__suspend,
        n = s.panel.navigation;
      const id = n.gesture.id;
      s.panel.updateData(s.data(94), s.config, s.pins);
      const waiting = s.panel.dataTimer !== undefined;
      s.panel.setActive(false);
      return {
        waiting,
        interacting: s.panel.interacting(),
        captured: s.panel.chart.over.hasPointerCapture(id),
        restored:
          JSON.stringify(s.panel.viewport()) === JSON.stringify(s.before),
        timer: s.panel.dataTimer ?? null,
      };
    }),
  ).toEqual({
    waiting: true,
    interacting: false,
    captured: false,
    restored: true,
    timer: null,
  });
  await page.mouse.up({ button: "right" });
  await settle(page);
  expect(
    await page.evaluate(() => {
      const s = (window as any).__suspend;
      s.panel.setActive(true);
      const n = s.panel.navigation;
      const rect = s.panel.chart.over.getBoundingClientRect();
      s.panel.chart.over.dispatchEvent(
        new WheelEvent("wheel", {
          ctrlKey: true,
          deltaY: -100,
          clientX: rect.x + rect.width / 2,
          clientY: rect.y + rect.height / 2,
          cancelable: true,
        }),
      );
      const waiting = !!n.wheelPending;
      s.panel.updateData(s.data(95), s.config, s.pins);
      s.panel.setActive(false);
      s.draws = 0;
      return {
        waiting,
        wheel: n.wheelPending ?? null,
        timer: s.panel.dataTimer ?? null,
      };
    }),
  ).toEqual({ waiting: true, wheel: null, timer: null });
  await settle(page);
  expect(
    await page.evaluate(() => {
      const s = (window as any).__suspend;
      return {
        draws: s.draws,
        restored:
          JSON.stringify(s.panel.viewport()) === JSON.stringify(s.before),
      };
    }),
  ).toEqual({ draws: 0, restored: true });
});

test("a never-rendered inactive plot keeps only the latest data and its initial camera", async ({
  page,
}) => {
  await fixture(page, false);
  expect(
    await page.evaluate(() => {
      const s = (window as any).__suspend;
      s.panel.setActive(false);
      s.initial = { x: [10, 70], y: [20, 80] };
      s.panel.render(s.data(90), s.config, s.pins, { initialView: s.initial });
      s.latest = s.data(99);
      s.panel.updateData(s.latest, s.config, s.pins);
      s.panel.setPins({ ...s.pins, a: 22 });
      return {
        canvases: s.host.querySelectorAll("canvas").length,
        listeners: s.listeners.length,
      };
    }),
  ).toEqual({ canvases: 0, listeners: 0 });
  expect(
    await page.evaluate(() => {
      const s = (window as any).__suspend;
      s.panel.setActive(true);
      return {
        latest: s.panel.analyzed === s.latest,
        view: s.panel.viewport(),
        pin: s.panel.pins.a,
      };
    }),
  ).toEqual({ latest: true, view: { x: [10, 70], y: [20, 80] }, pin: 22 });
});

test("color and pin-only edits resume on the retained canvas", async ({
  page,
}) => {
  await fixture(page);
  await page.evaluate(() => {
    const s = (window as any).__suspend;
    s.chart = s.panel.chart;
    s.navigation = s.panel.navigation;
    s.panel.setActive(false);
    s.draws = 0;
    s.panel.refreshColors({
      ...s.config,
      runs: { r1: { color: "#ff0000" }, r2: { color: "#00ff00" } },
    });
    s.panel.refreshColors({
      ...s.config,
      runs: { r1: { color: "#0000ff" }, r2: { color: "#00ff00" } },
    });
    s.panel.setPins({ ...s.pins, b: 75 });
  });
  await settle(page);
  expect(await page.evaluate(() => (window as any).__suspend.draws)).toBe(0);
  expect(
    await page.evaluate(() => {
      const s = (window as any).__suspend;
      s.panel.setActive(true);
      return {
        retained:
          s.chart === s.panel.chart && s.navigation === s.panel.navigation,
        color: s.panel.seriesColor(0),
        pin: s.panel.pins.b,
      };
    }),
  ).toEqual({ retained: true, color: "#0000ff", pin: 75 });
});

test("hover cleanup does not defer a new hidden repaint", async ({ page }) => {
  await fixture(page);
  const box = (await page.locator(".u-over").boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await settle(page);
  await page.evaluate(() => {
    const s = (window as any).__suspend;
    s.panel.setActive(false);
    s.draws = 0;
  });
  await settle(page);
  expect(
    await page.evaluate(() => {
      const s = (window as any).__suspend;
      return { draws: s.draws, hover: s.panel.hoverPointer ?? null };
    }),
  ).toEqual({ draws: 0, hover: null });
});
