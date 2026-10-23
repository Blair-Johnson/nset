import { test, expect, type Page, type TestInfo } from "@playwright/test";

// Source fixtures exercise the real shell and rendering components, not duplicated UI.
const palette = [
  "#60a5fa",
  "#c084fc",
  "#fbbf24",
  "#34d399",
  "#fb7185",
  "#22d3ee",
  "#f97316",
  "#e879f9",
];
const rgb = (hex: string) =>
  [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
function luminance(color: number[]) {
  const c = color
    .slice(0, 3)
    .map((n) => n / 255)
    .map((n) => (n <= 0.04045 ? n / 12.92 : ((n + 0.055) / 1.055) ** 2.4));
  return c[0] * 0.2126 + c[1] * 0.7152 + c[2] * 0.0722;
}
function contrast(a: number[], b: number[]) {
  const values = [luminance(a), luminance(b)].sort((a, b) => b - a);
  return (values[0] + 0.05) / (values[1] + 0.05);
}
async function capture(page: Page, info: TestInfo, name: string) {
  const path = info.outputPath(`${name}.png`);
  await page.screenshot({ path, fullPage: true });
  await info.attach(name, { path, contentType: "image/png" });
}
async function readable(page: Page, selector: string, control = false) {
  const samples = await page.locator(selector).evaluateAll((elements) => {
    const parse = (color: string) => color.match(/[\d.]+/g)!.map(Number);
    const mix = (fg: number[], bg: number[]) =>
      fg
        .slice(0, 3)
        .map((c, i) => c * (fg[3] ?? 1) + bg[i] * (1 - (fg[3] ?? 1)));
    const background = (el: Element | null): number[] => {
      if (!el) return [255, 255, 255];
      return mix(
        parse(getComputedStyle(el).backgroundColor),
        background(el.parentElement),
      );
    };
    return elements
      .filter((el) => el.getClientRects().length && !el.closest("[hidden]"))
      .map((el) => {
        const css = getComputedStyle(el),
          bg = background(el);
        return {
          label: `${el.className}: ${el.textContent?.slice(0, 60)}`,
          bg,
          fg: mix(parse(css.color), bg),
          border: mix(parse(css.borderTopColor), bg),
        };
      });
  });
  expect(samples.length, `visible samples: ${selector}`).toBeGreaterThan(0);
  for (const s of samples) {
    expect(
      contrast(s.fg, s.bg),
      `text contrast ${s.label}`,
    ).toBeGreaterThanOrEqual(4.5);
    if (control)
      expect(
        contrast(s.border, s.bg),
        `control boundary ${s.label}`,
      ).toBeGreaterThanOrEqual(3);
  }
}
async function darkSurfaces(page: Page) {
  const surfaces = await page
    .locator(
      "body, .app-header, .browser-panel, .data-table th, .menu-popover, .chart-card, .card-menu-items, .card-image-menu, .image-canvas, dialog, .ce-tabs, .ce-preview, .ce-preview-plot, .ce-footer",
    )
    .evaluateAll((els) =>
      els
        .filter((el) => el.getClientRects().length)
        .map((el) => ({
          selector: el.className || el.tagName,
          bg: getComputedStyle(el).backgroundColor,
        })),
    );
  for (const s of surfaces) {
    const color = s.bg.match(/[\d.]+/g)!.map(Number);
    if (color[3] === 0) continue;
    expect(
      luminance(color),
      `dark surface ${s.selector}: ${s.bg}`,
    ).toBeLessThan(0.12);
  }
  await expect(page.locator("html")).toHaveCSS("color-scheme", "dark");
}
async function fixture(page: Page) {
  const image = await page.evaluate(() => {
    const canvas = document.createElement("canvas");
    canvas.width = 80;
    canvas.height = 40;
    const ctx = canvas.getContext("2d")!;
    ctx.fillStyle = "rgb(230, 80, 45)";
    ctx.fillRect(0, 0, 40, 40);
    ctx.fillStyle = "rgb(40, 170, 120)";
    ctx.fillRect(40, 0, 40, 40);
    return canvas.toDataURL("image/png").split(",")[1];
  });
  const runs = ["finished", "running", "failed"].map((status, i) => ({
    id: `r${i + 1}`,
    experiment_id: "e1",
    name: `ResNet \u00b7 seed ${i + 1}`,
    status,
    params: { lr: 0.001 },
    tags: {},
    created_at: 1700000000000,
    updated_at: 1700000010000,
  }));
  await page.route("**/api/**", async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname === "/api/catalog")
      return route.fulfill({
        json: {
          experiments: [
            { id: "e1", name: "Vision study", created_at: 1700000000000 },
          ],
          runs,
          series: runs.flatMap((run) =>
            [
              "train/loss",
              "eval/accuracy",
              ...(run.id === "r1" ? ["eval/samples"] : []),
            ].map((key) => ({
              run_id: run.id,
              key,
              kind: key.endsWith("samples") ? "image" : "metric",
              count: 121,
              last_step: 120,
              last_timestamp: 1700000010000,
              last_value: key.endsWith("samples") ? null : 0.25,
            })),
          ),
        },
      });
    if (url.pathname.endsWith("/metrics"))
      return route.fulfill({
        json: {
          points: Array.from({ length: 121 }, (_, i) => ({
            seq: i + 1,
            step: i,
            timestamp: 1700000000000 + i * 1000,
            value:
              url.searchParams.get("key") === "train/loss"
                ? 3 * Math.exp(-i / 40) +
                  0.2 * Math.sin(i / 5) +
                  (url.pathname.includes("r2") ? 0.4 : 0)
                : 0.2 + i / 160,
          })),
          total: 121,
          snapshot: 121,
          next_after: null,
        },
      });
    if (url.pathname.endsWith("/images"))
      return route.fulfill({
        json: {
          images: [
            {
              id: "frame",
              run_id: "r1",
              key: "eval/samples",
              step: 0,
              timestamp: 1700000000000,
              content_type: "image/png",
              byte_length: Buffer.from(image, "base64").length,
            },
          ],
        },
      });
    if (url.pathname.endsWith("/content"))
      return route.fulfill({
        contentType: "image/png",
        body: Buffer.from(image, "base64"),
      });
    return route.fulfill({ status: 404, json: { error: "Missing fixture" } });
  });
  await page.goto("/");
  await readable(
    page,
    ".connect-form label, .connect-form h2, .connect-form .primary",
  );
  await readable(page, "#token", true);
  await darkSurfaces(page);
  await page.getByLabel("Access token", { exact: true }).fill("fixture-secret");
  await page.getByRole("button", { name: "Connect", exact: true }).click();
  await expect(page.locator("#connection")).toHaveText("Connected");
  await page.getByRole("button", { name: "Vision study", exact: true }).click();
}
async function dashboard(page: Page) {
  await page
    .getByRole("checkbox", { name: "Select all matching runs", exact: true })
    .check();
  await page.getByRole("button", { name: "View charts", exact: true }).click();
  await expect(page.locator(".card-plot canvas").first()).toBeVisible();
}

for (const width of [1440, 390])
  test(`dark shell, mixed dashboard and editor at ${width}px`, async ({
    page,
  }, info) => {
    await page.setViewportSize({ width, height: 1000 });
    await fixture(page);
    await readable(
      page,
      ".row-subtitle, .status, .data-table th, .run-link, .selection-count, .connection",
    );
    await readable(
      page,
      '.table-toolbar input[type="search"], .table-toolbar select',
      true,
    );
    await page.locator(".run-table tbody tr").first().hover();
    await readable(
      page,
      ".run-table tbody tr:first-child .row-subtitle, .run-table tbody tr:first-child .run-link",
    );
    await darkSurfaces(page);
    await capture(page, info, "runs");
    await dashboard(page);
    await readable(
      page,
      ".card-title, .card-legend, .section-count, .card-chart-toolbar button:not(:disabled)",
    );
    await readable(page, ".card-axis", true);
    await darkSurfaces(page);
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth),
    ).toBeLessThanOrEqual(width);
    await capture(page, info, "mixed-dashboard");
    const card = page.locator('[data-card-kind="timeseries"]').first();
    await card.getByRole("button", { name: "Inspect", exact: true }).click();
    await readable(
      page,
      ".card-pin-label, .card-coordinate, .card-value-table",
    );
    await card.locator(".card-menu-toggle").click();
    await readable(page, ".card-menu-items button");
    await darkSurfaces(page);
    await card.getByRole("button", { name: "Edit chart", exact: true }).click();
    await expect(page.locator(".chart-editor")).toBeVisible();
    for (const tab of ["Data", "Axes", "Appearance"]) {
      await page.getByRole("tab", { name: tab, exact: true }).click();
      await readable(
        page,
        ".ce-tabs button, .ce-panel:not([hidden]) label, .ce-help:not(:empty), .ce-muted, .ce-primary",
      );
      await readable(
        page,
        '.ce-panel:not([hidden]) select, .ce-panel:not([hidden]) input:not([type="checkbox"]):not([type="range"])',
        true,
      );
      await darkSurfaces(page);
      await capture(page, info, `editor-${tab.toLowerCase()}`);
    }
    await page.getByRole("button", { name: "Cancel", exact: true }).click();
  });

test("rendered axes, grid, series and pins are dark-safe; saved custom colors still win", async ({
  page,
}, info) => {
  await page.route("**/__dark_plot", (route) =>
    route.fulfill({
      contentType: "text/html",
      body: '<!doctype html><html><body><main id="plot" style="width:900px;padding:20px;background:var(--surface)"></main></body></html>',
    }),
  );
  await page.goto("/__dark_plot");
  const result = await page.evaluate(async () => {
    await import("/src/style.css");
    const { PlotPanel, analyze } = await import("/src/plot.ts");
    const { defaults, palette } = await import("/src/config.ts");
    const { newChart } = await import("/src/workspace.ts");
    const plot = new PlotPanel(
      document.querySelector("#plot")!,
      () => {},
      () => {},
    );
    const config = newChart("timeseries", ["loss"]).config;
    const raw = Array.from({ length: 51 }, (_, i) => ({
      seq: i + 1,
      step: i,
      timestamp: i,
      value: 1 + Math.sin(i / 8),
    }));
    const data = [
      {
        run: {
          id: "r",
          name: "Loss",
          experiment_id: "e",
          status: "finished",
          params: {},
          tags: {},
          created_at: 0,
          updated_at: 0,
        },
        raw,
      },
    ];
    const pins = { a: 12, b: 33, threshold: 1.4 };
    await plot.render(analyze(data, config), config, pins);
    const inspect = () => {
      const chart = (plot as any).chart;
      return chart.axes.map((axis: any, i: number) => ({
        stroke: axis.stroke(chart, i),
        grid: axis.grid.stroke(chart, i),
        ticks: axis.ticks.stroke(chart, i),
      }));
    };
    const axes = inspect();
    (window as any).themePlot = {
      plot,
      data,
      config,
      pins,
      defaults,
      inspect,
      analyze,
    };
    return { axes, palette };
  });
  expect(result.palette).toEqual(palette);
  for (const axis of result.axes) {
    expect(axis).toEqual({
      stroke: "#abb3bc",
      grid: "#363b40",
      ticks: "#737b84",
    });
    expect(contrast(rgb(axis.stroke), rgb("#1e2022"))).toBeGreaterThanOrEqual(
      4.5,
    );
    expect(contrast(rgb(axis.ticks), rgb("#1e2022"))).toBeGreaterThanOrEqual(3);
  }
  for (const color of [...palette, "#7dd3fc", "#d8b4fe", "#fbbf24"])
    expect(contrast(rgb(color), rgb("#1e2022"))).toBeGreaterThanOrEqual(3);
  // Check actual canvas pixels, including axis labels and inspection cursors.
  const counts = await page.locator("#plot canvas").evaluate((el) => {
    const canvas = el as HTMLCanvasElement,
      pixels = canvas
        .getContext("2d")!
        .getImageData(0, 0, canvas.width, canvas.height).data;
    const colors = [
      [96, 165, 250],
      [171, 179, 188],
      [125, 211, 252],
      [216, 180, 254],
      [251, 191, 36],
    ];
    return colors.map((rgb) => {
      let count = 0;
      for (let i = 0; i < pixels.length; i += 4)
        if (
          pixels[i + 3] > 200 &&
          rgb.every((v, j) => Math.abs(v - pixels[i + j]) <= 2)
        )
          count++;
      return count;
    });
  });
  for (const count of counts) expect(count).toBeGreaterThan(5);
  await capture(page, info, "plot-defaults-and-pins");
  const preserved = await page.evaluate(async () => {
    const { plot, data, pins, defaults, inspect, analyze } = (window as any)
      .themePlot;
    const config = defaults();
    await plot.render(analyze(data, config), config, pins);
    const legacyAxes = inspect();
    config.palette = false;
    config.style.color = "#ff00ff";
    config.advanced = {
      axes: [
        { stroke: "#abcdef", grid: { stroke: "#654321" } },
        { stroke: "#fedcba" },
      ],
    };
    await plot.render(analyze(data, config), config, pins);
    const chart = plot.chart;
    return {
      legacyAxes,
      customAxes: inspect(),
      series: chart.series[2].stroke(chart, 2),
      configColor: config.style.color,
    };
  });
  expect(preserved.legacyAxes).toEqual(result.axes);
  expect(preserved.customAxes[0].stroke).toBe("#abcdef");
  expect(preserved.customAxes[0].grid).toBe("#654321");
  expect(preserved.customAxes[1].stroke).toBe("#fedcba");
  expect(preserved.series).toBe("#ff00ff");
  expect(preserved.configColor).toBe("#ff00ff");
});

test("image pixels stay unchanged on neutral canvases, including fullscreen", async ({
  page,
}, info) => {
  await fixture(page);
  await dashboard(page);
  const image = page.locator('[data-card-kind="image"]');
  await image.scrollIntoViewIfNeeded();
  await expect(image.locator(".frame-info")).toHaveText("Step 0 \u00b7 1 / 1");
  await expect(image.locator(".image-canvas")).toHaveCSS(
    "background-color",
    "rgb(21, 22, 23)",
  );
  await expect
    .poll(async () =>
      image.locator("canvas").evaluateAll((canvases) =>
        canvases.reduce((count, el) => {
          const canvas = el as HTMLCanvasElement;
          const context = canvas.getContext("2d");
          if (!context) return count;
          const data = context.getImageData(
            0,
            0,
            canvas.width,
            canvas.height,
          ).data;
          for (let i = 0; i < data.length; i += 4)
            if (
              data[i] === 230 &&
              data[i + 1] === 80 &&
              data[i + 2] === 45 &&
              data[i + 3] === 255
            )
              count++;
          return count;
        }, 0),
      ),
    )
    .toBeGreaterThan(100);
  await image.locator(".card-image-more > summary").click();
  await readable(page, ".card-image-menu button");
  // Compact image cards use card maximization. Exercise the same real panel's
  // native fullscreen CSS with a trusted click, rather than inventing its UI.
  await image.locator(".card-image-panel").evaluate((panel) => {
    panel.addEventListener("click", () => void panel.requestFullscreen(), {
      once: true,
    });
  });
  await image.locator(".image-canvas").click();
  await expect(page.locator(".card-image-panel:fullscreen")).toBeVisible();
  await readable(
    page,
    ".card-image-timeline .frame-info, .card-image-toolbar button",
  );
  await darkSurfaces(page);
  await capture(page, info, "image-fullscreen");
  await page.evaluate(() => document.exitFullscreen());
});

test("empty, error, validation and maximized-card surfaces remain readable", async ({
  page,
}, info) => {
  await fixture(page);
  const search = page.locator('.table-toolbar input[type="search"]');
  await search.fill("no matching run");
  await readable(page, ".empty-table");
  await darkSurfaces(page);
  await search.fill("");
  await page.route("**/api/runs/*/metrics?**", (route) =>
    route.fulfill({
      status: 500,
      json: { error: "Fixture metric service unavailable" },
    }),
  );
  await page
    .getByRole("checkbox", { name: "Select all matching runs", exact: true })
    .check();
  await page.getByRole("button", { name: "View charts", exact: true }).click();
  const card = page.locator('[data-card-kind="timeseries"]').first();
  await expect(card.locator(".card-status")).toContainText("unavailable");
  await readable(page, ".card-status");
  await card
    .getByRole("button", { name: "Maximize chart", exact: true })
    .click();
  await expect(card.locator(".chart-card")).toHaveClass(/card-maximized/);
  await darkSurfaces(page);
  await capture(page, info, "maximized-error");
  await page.keyboard.press("Escape");
  await card.locator(".card-menu-toggle").click();
  await card.getByRole("button", { name: "Edit chart", exact: true }).click();
  await page.getByLabel("Chart title", { exact: true }).fill("");
  await page.getByRole("button", { name: "Save changes", exact: true }).click();
  await expect(
    page.locator(".ce-error").filter({ hasText: "Give this chart a title" }),
  ).toBeVisible();
  await readable(page, ".ce-error:not(:empty)");
  await darkSurfaces(page);
  await capture(page, info, "editor-validation-error");
});
