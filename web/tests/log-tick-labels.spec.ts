import { test, expect } from "@playwright/test";

test("log axes omit filtered labels rather than drawing rows of missing-value dashes", async ({
  page,
}, info) => {
  await page.goto("/");
  await page.evaluate(async () => {
    const { PlotPanel } = await import("/src/plot.ts");
    const { validateConfig } = await import("/src/config.ts");
    const { makeInterpolator } = await import("/src/math.ts");
    const host = document.createElement("div");
    host.style.width = "900px";
    document.body.replaceChildren(host);
    const points = [
      [1, 0.001],
      [1000, 0.001],
      [100000, 0.000001],
    ];
    const panel = new PlotPanel(
      host,
      () => {},
      () => {},
    );
    panel.render(
      [
        {
          run: { id: "r", name: "Learning rate" },
          points,
          observations: points,
          count: points.length,
          fn: makeInterpolator(points, "linear"),
        },
      ],
      validateConfig({
        height: 340,
        xScale: "log",
        yScale: "log",
        xMin: 1,
        xMax: 100000,
        yMin: 0.000001,
        yMax: 0.01,
        yLabel: "train/learning_rate",
      }),
      { a: null, b: null, threshold: null },
    );
    (window as any).__logTicks = panel;
  });
  await expect(page.locator(".u-over")).toBeVisible();
  const labels = () =>
    page.evaluate(() =>
      (window as any).__logTicks.chart.axes.map((axis: any) => axis._values),
    );
  await expect
    .poll(async () =>
      (await labels()).every((axis: string[]) => axis.includes("")),
    )
    .toBe(true);
  for (const axis of await labels()) {
    expect(axis).not.toContain("—");
    expect(axis.filter((label: string) => label !== "").length).toBeGreaterThan(
      1,
    );
  }
  await page.screenshot({
    path: info.outputPath("log-learning-rate-labels.png"),
  });
  await page.evaluate(() => (window as any).__logTicks.zoom(2));
  for (const axis of await labels()) expect(axis).not.toContain("—");
});
