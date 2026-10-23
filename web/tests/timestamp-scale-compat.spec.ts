import { test, expect } from "@playwright/test";

for (const scale of ["log", "asinh"] as const) {
  test(`nonlinear ${scale} wall time retains explicit legacy formatting`, async ({
    page,
  }, info) => {
    await page.route(/^http:\/\/127\.0\.0\.1:[0-9]+\/$/, (route) =>
      route.fulfill({
        contentType: "text/html",
        body: "<!doctype html><html><body><main></main></body></html>",
      }),
    );
    await page.goto("/");
    const result = await page.evaluate(async (scale) => {
      await import("/src/style.css");
      await import("/node_modules/uplot/dist/uPlot.min.css");
      const { default: uPlot } =
        await import("/node_modules/uplot/dist/uPlot.esm.js");
      const { defaults } = await import("/src/config.ts");
      const { defaultLabelLayout } = await import("/src/axis-labels.ts");
      const { resolveOptions } = await import("/src/options.ts");
      const config = {
        ...defaults(),
        axis: "timestamp",
        xScale: scale,
        xMin: 0.01,
        xMax: 1,
        height: 300,
      };
      const options = resolveOptions(config, 650, [{}, { stroke: "#8bc9ff" }]);
      const policy = {
        layout: defaultLabelLayout(config),
        size: options.axes[0].size,
        align: options.axes[0].align ?? null,
        increments: options.axes[0].incrs ?? null,
      };
      const data = [
        [0.01, 0.03, 0.1, 0.3, 1],
        [1, 2, 3, 2, 1],
      ];
      const plot = new uPlot(options, data, document.querySelector("main"));
      (window as any).compatPlot = plot;
      return {
        policy,
        data: plot.data,
        labels: plot.axes[0]._values,
        width: plot.bbox.width,
      };
    }, scale);
    expect(result.policy.layout.multilineTime).toBe(false);
    expect(result.policy.size).toBe(32);
    expect(result.policy.align).toBeNull();
    expect(result.policy.increments).toBeNull();
    expect(result.width).toBeGreaterThan(400);
    expect(result.data[0]).toEqual([0.01, 0.03, 0.1, 0.3, 1]);
    expect(result.labels.filter(Boolean).length).toBeGreaterThan(0);
    expect(result.labels.every((label: string) => !label.includes("\n"))).toBe(
      true,
    );
    await page.screenshot({
      path: info.outputPath(`${scale}-legacy-time.png`),
    });
  });
}
