import { expect, test, type Page } from "@playwright/test";

async function fixture(page: Page) {
  await page.route(/^http:\/\/127\.0\.0\.1:[0-9]+\/$/, (route) =>
    route.fulfill({
      contentType: "text/html",
      body: "<!doctype html><body></body>",
    }),
  );
  await page.goto("/");
  await page.evaluate(async () => {
    // Suppress automatic delivery so reveal behavior does not depend on timing.
    const intersections: any[] = [];
    (window as any).IntersectionObserver = class {
      target?: Element;
      constructor(readonly callback: IntersectionObserverCallback) {
        intersections.push(this);
      }
      observe(target: Element) {
        this.target = target;
      }
      disconnect() {
        this.target = undefined;
      }
    };
    const { ChartCard } = await import("/src/cards.ts");
    const { newChart } = await import("/src/workspace.ts");
    const run = {
      id: "r",
      name: "Run",
      experiment_id: "e",
      status: "finished",
      params: {},
      tags: {},
      created_at: 0,
      updated_at: 0,
    };
    const catalog = {
      experiments: [],
      runs: [run],
      series: ["metric", "image"].map((kind) => ({
        run_id: "r",
        key: kind === "image" ? "frame" : "loss",
        kind,
        count: 3,
        last_step: 2,
        last_timestamp: 2,
        last_value: 2,
      })),
    };
    const state: any = { scalarLoads: 0, imageLoads: 0, catalog };
    const context = {
      api: {
        async json() {
          state.imageLoads++;
          return { images: [] };
        },
      },
      catalog: { ...catalog, series: [] },
      selectedRunIds: ["r"],
      store: {
        clear() {},
        async load() {
          state.scalarLoads++;
          return [0, 1, 2].map((step) => ({
            seq: step,
            step,
            timestamp: step,
            value: step + 1,
          }));
        },
      },
    };
    const actions = {
      onEdit() {},
      onDuplicate() {},
      onRemove() {},
      onMove() {},
      onResize() {},
    };
    const make = (kind: "image" | "timeseries") => {
      const host = document.createElement("div");
      document.body.append(host);
      const spec = newChart(kind, [kind === "image" ? "frame" : "loss"], kind);
      spec.layout = { width: 640, height: 400 };
      return new ChartCard(host, spec, context, actions);
    };
    state.scalar = make("timeseries");
    state.image = make("image");
    state.context = context;
    state.deliver = (visible: boolean) => {
      for (const observer of intersections)
        if (observer.target)
          observer.callback([
            { target: observer.target, isIntersecting: visible },
          ]);
    };
    (window as any).panelDemand = state;
  });
}

test("empty and undemanded cards stay shells through spec, catalog, and API changes", async ({
  page,
}) => {
  await fixture(page);
  await page.evaluate(() => {
    const s = (window as any).panelDemand;
    s.deliver(true); // Known-empty cards still must not create panels.
  });
  await expect(
    page.locator(".card-plot, [data-role=image-viewer]"),
  ).toHaveCount(0);
  await page.evaluate(() => {
    const s = (window as any).panelDemand;
    s.deliver(false);
    s.scalar.updateCatalog(s.catalog);
    s.image.updateCatalog(s.catalog);
    s.scalar.setSpec({
      ...s.scalar.spec,
      config: { ...s.scalar.spec.config, smoothing: true },
    });
    s.image.setContext({
      ...s.context,
      catalog: s.catalog,
      api: { ...s.context.api },
    });
  });
  await expect(
    page.locator(".card-plot, [data-role=image-viewer]"),
  ).toHaveCount(0);
  expect(
    await page.evaluate(() => {
      const s = (window as any).panelDemand;
      return [
        s.scalarLoads,
        s.imageLoads,
        !!s.scalar.foldObserver,
        !!s.image.foldObserver,
      ];
    }),
  ).toEqual([0, 0, false, false]);
  await page.evaluate(() => (window as any).panelDemand.deliver(true));
  await expect(page.locator(".u-over")).toHaveCount(1);
  await expect(page.locator("[data-role=image-viewer]")).toHaveCount(1);
  expect(
    await page.evaluate(() => {
      const s = (window as any).panelDemand;
      return [s.scalarLoads, s.imageLoads, !!s.image.plot];
    }),
  ).toEqual([1, 1, false]);
});

test("measurement reveal materializes lazily and hidden transforms retain raw data and navigation", async ({
  page,
}) => {
  await fixture(page);
  expect(
    await page.evaluate(async () => {
      const s = (window as any).panelDemand;
      s.scalar.updateCatalog(s.catalog);
      return s.scalar.showMeasurement({ axis: "x", a: 0.5, b: 1.5 });
    }),
  ).toBe(true);
  const hidden = await page.evaluate(() => {
    const s = (window as any).panelDemand;
    const card = s.scalar;
    card.plot.zoom(1.5, "both");
    s.before = {
      plot: card.plot,
      raw: card.raw,
      data: card.data,
      camera: card.plot.viewport(),
      pins: { ...card.pins },
      canGoBack: card.plot.canGoBack(),
    };
    card.setActive(false);
    card.setSpec({
      ...card.spec,
      config: { ...card.spec.config, smoothing: true, smoothingSigma: 2 },
    });
    card.refreshColors();
    card.setRunOrder(["r"]);
    return {
      samePlot: card.plot === s.before.plot,
      sameRaw: card.raw === s.before.raw,
      sameData: card.data === s.before.data,
      foldsActive: card.foldsActive,
      transformDirty: card.transformDirty,
      loads: s.scalarLoads,
    };
  });
  expect(hidden).toEqual({
    samePlot: true,
    sameRaw: true,
    sameData: true,
    foldsActive: false,
    transformDirty: true,
    loads: 1,
  });
  expect(
    await page.evaluate(() => {
      const s = (window as any).panelDemand;
      const card = s.scalar;
      card.setActive(true);
      return {
        samePlot: card.plot === s.before.plot,
        sameRaw: card.raw === s.before.raw,
        transformed: card.data !== s.before.data,
        camera:
          JSON.stringify(card.plot.viewport()) ===
          JSON.stringify(s.before.camera),
        pins: JSON.stringify(card.pins) === JSON.stringify(s.before.pins),
        history: card.plot.canGoBack() === s.before.canGoBack,
        loads: s.scalarLoads,
      };
    }),
  ).toEqual({
    samePlot: true,
    sameRaw: true,
    transformed: true,
    camera: true,
    pins: true,
    history: true,
    loads: 1,
  });
});
