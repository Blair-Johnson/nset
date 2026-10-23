import { test, expect, type Page } from "@playwright/test";

type FixtureOptions = {
  empty?: boolean;
  explicit?: boolean;
  image?: boolean;
  delayed?: boolean;
  constant?: boolean;
  advanced?: boolean;
  saveError?: boolean;
  many?: boolean;
  imagePreview?: boolean;
  onClose?: boolean;
  twoOrigins?: boolean;
  config?: Record<string, unknown>;
  /** Leave folds as the editor opens them (closed). */
  keepFolds?: boolean;
};
async function fixture(page: Page, options: FixtureOptions = {}) {
  await page.route("**/__editor_fixture", (route) =>
    route.fulfill({
      contentType: "text/html",
      body: '<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"></head><body><button id="launch">Edit loss chart</button></body></html>',
    }),
  );
  await page.goto("/__editor_fixture");
  await page.evaluate(async (options) => {
    await import("/src/style.css");
    const { openChartEditor } = await import("/src/chart-editor.ts");
    const { newChart } = await import("/src/workspace.ts");
    const runs = [
      {
        id: "r1",
        experiment_id: "e1",
        name: "ResNet seed 1",
        status: "finished",
        params: {},
        tags: {},
        created_at: 0,
        updated_at: 0,
      },
      {
        id: "r2",
        experiment_id: "e2",
        name: "Transfer seed 2",
        status: "running",
        params: {},
        tags: {},
        created_at: 0,
        updated_at: 0,
      },
    ];
    if (options.twoOrigins) {
      runs[0].created_at = 1700000000000;
      runs[1].created_at = 1700100000000;
    }
    const series = (run_id: string, key: string, kind = "metric") => ({
      run_id,
      key,
      kind,
      count: 301,
      last_step: 300,
      last_timestamp: 9000,
      last_value: kind === "metric" ? 0.5 : null,
    });
    const catalog = {
      experiments: [
        { id: "e1", name: "ImageNet baseline", created_at: 0 },
        { id: "e2", name: "Fine tuning", created_at: 0 },
      ],
      runs,
      series: [
        series("r1", "train/loss"),
        series("r1", "eval/accuracy"),
        series("r2", "eval/loss"),
        series("r1", "eval/samples", "image"),
        ...(options.many
          ? Array.from({ length: 105 }, (_, i) =>
              series("r1", `metrics/${String(i).padStart(3, "0")}`),
            )
          : []),
      ],
    };
    const card = newChart(
      options.image ? "image" : "timeseries",
      options.empty ? [] : [options.image ? "eval/samples" : "train/loss"],
      "Training loss",
    );
    if (options.explicit)
      card.source = {
        mode: "explicit",
        series: [{ runId: "gone", key: "old/loss", kind: "metric" }],
      };
    if (options.advanced)
      card.config.advanced = {
        title: "Saved plot title",
        padding: [12, 13, 14, 15],
        scales: { y: { auto: false, range: [1, 10], dir: -1, log: 2 } },
        axes: [
          {
            label: "Saved step",
            grid: { show: false, stroke: "navy" },
            values: "scientific",
          },
          { grid: { show: false, width: 2 } },
        ],
        legend: { show: false, isolate: true },
      };
    if (options.twoOrigins)
      card.source = {
        mode: "explicit",
        series: [
          { runId: "r1", key: "train/loss", kind: "metric" },
          { runId: "r2", key: "eval/loss", kind: "metric" },
        ],
      };
    Object.assign(card.config, options.config);
    const state: any = {
      closes: [],
      plots: [],
      renderCount: 0,
      requests: [],
      card,
      original: structuredClone(card),
      saved: [],
      loads: [],
      aborted: [],
      rejectSave: !!options.saveError,
      delay: options.delayed ? 3000 : 0,
      ignoreAbort: false,
      failLoads: false,
    };
    const store = {
      clear() {},
      load(ref: any, signal?: AbortSignal) {
        state.loads.push(ref);
        const points = Array.from({ length: 301 }, (_, i) => ({
          seq: i,
          step: i,
          timestamp:
            (runs.find((run) => run.id === ref.runId)?.created_at ?? 0) +
            1000 +
            i * i,
          value: options.constant
            ? 5
            : i === 177
              ? 900
              : 1 + Math.exp(-i / 100),
        }));
        if (state.failLoads)
          return Promise.reject(new Error("History offline"));
        if (!state.delay) return Promise.resolve(points);
        return new Promise((resolve, reject) => {
          const timer = setTimeout(() => resolve(points), state.delay);
          signal?.addEventListener(
            "abort",
            () => {
              state.aborted.push(ref.key);
              if (state.ignoreAbort) return;
              clearTimeout(timer);
              reject(new DOMException("Aborted", "AbortError"));
            },
            { once: true },
          );
        });
      },
    };
    const { PlotPanel } = await import("/src/plot.ts");
    const originalRender = PlotPanel.prototype.render;
    PlotPanel.prototype.render = function (data: any, config: any, pins: any) {
      state.rendered = this;
      state.plots.push({
        config: structuredClone(config),
        counts: data.map((series: any) => series.count),
        xEnds: data.map((series: any) => [
          series.observations[0][0],
          series.observations.at(-1)[0],
        ]),
        max: Math.max(
          ...data.flatMap((series: any) =>
            series.observations.map((point: any) => point[1]),
          ),
        ),
      });
      const result = originalRender.call(this, data, config, pins);
      state.renderCount++;
      return result;
    };
    let api;
    if (options.imagePreview) {
      const { Api } = await import("/src/api.ts");
      const canvas = document.createElement("canvas");
      canvas.width = 40;
      canvas.height = 30;
      const context = canvas.getContext("2d")!;
      context.fillStyle = "#2563eb";
      context.fillRect(0, 0, 20, 30);
      context.fillStyle = "#16a34a";
      context.fillRect(20, 0, 20, 30);
      const blob = await new Promise<Blob>((resolve) =>
        canvas.toBlob((blob) => resolve(blob!)),
      );
      api = new Api(
        () => "fixture-token",
        async (url: any, init: any) => {
          state.requests.push({
            url: String(url),
            authorization: init.headers.Authorization,
          });
          if (String(url).endsWith("/images"))
            return Response.json({
              images: [
                {
                  id: "frame-one",
                  run_id: "r1",
                  key: "eval/samples",
                  step: 20,
                  timestamp: 1000,
                  content_type: "image/png",
                  byte_length: blob.size,
                },
                {
                  id: "unchosen",
                  run_id: "r1",
                  key: "private/unchosen",
                  step: 20,
                  timestamp: 1000,
                  content_type: "image/png",
                  byte_length: blob.size,
                },
              ],
            });
          return new Response(blob, {
            headers: { "content-type": "image/png" },
          });
        },
      );
    }
    if (options.onClose) {
      const menu = document.createElement("details");
      menu.innerHTML = '<summary id="current-menu">Chart actions</summary>';
      document.body.append(menu);
    }
    const launch = document.querySelector<HTMLButtonElement>("#launch")!;
    launch.onclick = () => {
      state.handle = openChartEditor({
        card: state.card,
        catalog: catalog as any,
        selectedRunIds: ["r1"],
        store,
        api,
        onClose: options.onClose
          ? () => {
              state.closes.push({
                dialogPresent: !!document.querySelector("dialog.chart-editor"),
                focus: document.activeElement?.id,
              });
              document.querySelector<HTMLElement>("#current-menu")!.focus({
                preventScroll: true,
              });
              // A host may call close again while handling closure.
              state.handle.close();
            }
          : undefined,
        onSave(next: any) {
          if (state.rejectSave) {
            state.rejectSave = false;
            throw new Error("Storage full");
          }
          state.saved.push(next);
        },
      });
    };
    (window as any).__editor = state;
    launch.focus();
    launch.click();
  }, options);
  await expect(page.getByRole("dialog", { name: "Edit chart" })).toBeVisible();
  // Behavior tests reach into folded sections directly; open them all once.
  if (!options.keepFolds) await openFolds(page);
}
const dialog = (page: Page) => page.getByRole("dialog", { name: "Edit chart" });
// Folds start closed. Tests that reach for a control open every fold first
// (as a user would open the one they need), then scroll to the heading.
const SECTION_ALIASES: Record<string, string> = {
  Data: "Y axis",
  Axes: "X axis",
};
const section = async (page: Page, name: string) => {
  await dialog(page)
    .locator("details.ce-fold, details.ce-axis-options")
    .evaluateAll((folds) =>
      folds.forEach((fold) => ((fold as HTMLDetailsElement).open = true)),
    );
  await dialog(page)
    .getByRole("heading", { name: SECTION_ALIASES[name] ?? name, exact: true })
    .scrollIntoViewIfNeeded();
};
const openFolds = (page: Page) => section(page, "Chart");
const state = (page: Page) =>
  page.evaluate(() => {
    const s = (window as any).__editor;
    return {
      card: s.card,
      original: s.original,
      saved: s.saved,
      loads: s.loads,
      aborted: s.aborted,
      plots: s.plots,
      renderCount: s.renderCount,
      requests: s.requests,
    };
  });

test("isolated draft, Cancel/Escape, focus return and live full-history preview", async ({
  page,
}) => {
  await fixture(page);
  await expect(
    dialog(page).getByText("1 curve(s) · 301 observations", { exact: true }),
  ).toBeVisible();
  await expect(dialog(page).locator(".u-over")).toBeVisible();
  expect(await dialog(page).innerText()).not.toMatch(
    /raw-derived|raw observations|canonical|authoritative/i,
  );
  await dialog(page)
    .getByLabel("Chart title", { exact: true })
    .fill("Draft only");
  await section(page, "Appearance");
  await dialog(page)
    .getByRole("slider", { name: "Smoothing strength" })
    .fill("50");
  expect((await state(page)).card).toEqual((await state(page)).original);
  await dialog(page)
    .getByRole("button", { name: "Cancel", exact: true })
    .click();
  await expect(dialog(page)).toHaveCount(0);
  await expect(page.locator("#launch")).toBeFocused();
  expect((await state(page)).saved).toHaveLength(0);
  await page.locator("#launch").click();
  await page.keyboard.press("Escape");
  await expect(dialog(page)).toHaveCount(0);
  await expect(page.locator("#launch")).toBeFocused();
});

test("empty source validation, bounded search/paging, and multiple Y metrics", async ({
  page,
}) => {
  await fixture(page, { empty: true, many: true });
  await expect.poll(async () => (await state(page)).loads.length).toBe(0);
  await dialog(page)
    .getByRole("button", { name: "Save changes", exact: true })
    .click();
  await expect(
    dialog(page).getByText("Choose at least one metric.", { exact: true }),
  ).toBeVisible();
  expect(await dialog(page).locator(".ce-source-list input").count()).toBe(20);
  await dialog(page).getByRole("button", { name: "Next sources" }).click();
  await expect(dialog(page).getByText("107 results · 2 / 6")).toBeVisible();
  await dialog(page)
    .getByLabel("Find metrics", { exact: true })
    .fill("train/loss");
  await dialog(page)
    .getByRole("checkbox", { name: /train\/loss —/ })
    .check();
  await dialog(page)
    .getByLabel("Find metrics", { exact: true })
    .fill("eval/accuracy");
  await dialog(page)
    .getByRole("checkbox", { name: /eval\/accuracy —/ })
    .check();
  await expect(
    dialog(page).getByText("2 curve(s) · 602 observations", { exact: true }),
  ).toBeVisible();
  await dialog(page)
    .getByRole("button", { name: "Save changes", exact: true })
    .click();
  expect((await state(page)).saved[0].source.keys).toEqual([
    "train/loss",
    "eval/accuracy",
  ]);
});

test("cross-experiment picker preserves missing sources, filters media, and saves exact refs", async ({
  page,
}) => {
  await fixture(page, { explicit: true });
  await expect(
    dialog(page).getByText("1 chosen · 1 unavailable (kept)", { exact: true }),
  ).toBeVisible();
  await dialog(page)
    .getByLabel("Find metrics", { exact: true })
    .fill("Fine tuning Transfer");
  await dialog(page)
    .getByRole("checkbox", { name: /eval\/loss — Fine tuning/ })
    .check();
  await dialog(page)
    .getByLabel("Find metrics", { exact: true })
    .fill("samples");
  expect(await dialog(page).locator(".ce-source-list input").count()).toBe(0);
  await dialog(page)
    .getByRole("button", { name: "Save changes", exact: true })
    .click();
  const saved = (await state(page)).saved[0];
  expect(saved.source.series).toEqual([
    { runId: "gone", key: "old/loss", kind: "metric" },
    { runId: "r2", key: "eval/loss", kind: "metric" },
  ]);
});

test("bounds errors remain near controls and drafts survive failed saves", async ({
  page,
}) => {
  await fixture(page, { saveError: true });
  await dialog(page)
    .getByLabel("Chart title", { exact: true })
    .fill("Validation draft");
  await section(page, "Axes");
  await dialog(page)
    .getByLabel("Y bounds", { exact: true })
    .selectOption("manual");
  await dialog(page).getByLabel("Y minimum", { exact: true }).fill("8");
  await dialog(page).getByLabel("Y maximum", { exact: true }).fill("2");
  await dialog(page)
    .getByRole("button", { name: "Save changes", exact: true })
    .click();
  await expect(
    dialog(page).getByText("Minimum must be less than maximum.", {
      exact: true,
    }),
  ).toBeVisible();
  expect((await state(page)).saved).toHaveLength(0);
  await dialog(page).getByLabel("Y maximum", { exact: true }).fill("10");
  await dialog(page)
    .getByRole("button", { name: "Save changes", exact: true })
    .click();
  await expect(
    dialog(page).getByText(/Could not save: Storage full/),
  ).toBeVisible();
  await expect(
    dialog(page).getByLabel("Y minimum", { exact: true }),
  ).toHaveValue("8");
  await dialog(page)
    .getByRole("button", { name: "Save changes", exact: true })
    .click();
  expect((await state(page)).saved[0].title).toBe("Validation draft");
});

test("simple fields display effective advanced values, then remove only conflicting overrides", async ({
  page,
}) => {
  await fixture(page, { advanced: true });
  await dialog(page)
    .getByLabel("Chart title", { exact: true })
    .fill("New title");
  await section(page, "Axes");
  await expect(
    dialog(page).getByLabel("Y minimum", { exact: true }),
  ).toHaveValue("1");
  await dialog(page).getByLabel("Y minimum", { exact: true }).fill("2");
  await expect(
    dialog(page).getByLabel("X axis title", { exact: true }),
  ).toHaveValue("Saved step");
  await expect(
    dialog(page).getByLabel("X number format", { exact: true }),
  ).toHaveValue("scientific");
  await dialog(page)
    .getByLabel("X axis title", { exact: true })
    .fill("Iteration");
  await dialog(page)
    .getByLabel("X number format", { exact: true })
    .selectOption("fixed-2");
  await section(page, "Appearance");
  await expect(
    dialog(page).getByLabel("Show grid", { exact: true }),
  ).not.toBeChecked();
  await dialog(page).getByLabel("Show grid", { exact: true }).check();
  await dialog(page).getByLabel("Show legend", { exact: true }).check();
  await dialog(page)
    .getByRole("button", { name: "Save changes", exact: true })
    .click();
  const config = (await state(page)).saved[0].config;
  expect(config.advanced.title).toBeUndefined();
  expect(config.advanced.padding).toEqual([12, 13, 14, 15]);
  expect(config.advanced.scales.y).toEqual({ dir: -1, log: 2 });
  expect(config.advanced.axes[0]).toEqual({ grid: { stroke: "navy" } });
  expect(config.advanced.legend).toEqual({ isolate: true });
  expect(config.yMin).toBe(2);
  expect(config.xLabel).toBe("Iteration");
});

test("settings reuse loaded full histories; source changes and close cancel pending loads", async ({
  page,
}) => {
  await fixture(page);
  await expect(
    dialog(page).getByText("1 curve(s) · 301 observations", { exact: true }),
  ).toBeVisible();
  await section(page, "Appearance");
  await dialog(page)
    .getByRole("slider", { name: "Smoothing strength" })
    .fill("50");
  await dialog(page)
    .getByLabel("Between observations", { exact: true })
    .selectOption("pchip");
  await expect(
    dialog(page).getByText("1 curve(s) · 301 observations", { exact: true }),
  ).toBeVisible();
  expect((await state(page)).loads).toHaveLength(1);
  await dialog(page)
    .getByRole("button", { name: "Cancel", exact: true })
    .click();
  await fixture(page, { delayed: true });
  await expect.poll(async () => (await state(page)).loads.length).toBe(1);
  await dialog(page)
    .getByRole("checkbox", { name: /train\/loss —/ })
    .uncheck();
  await expect
    .poll(async () => (await state(page)).aborted)
    .toEqual(["train/loss"]);
  await dialog(page)
    .getByRole("checkbox", { name: /eval\/accuracy —/ })
    .check();
  await expect.poll(async () => (await state(page)).loads.length).toBe(2);
  await page.keyboard.press("Escape");
  await expect
    .poll(async () => (await state(page)).aborted)
    .toEqual(["train/loss", "eval/accuracy"]);
});

test("image sources have no misleading numeric controls and no metric loads", async ({
  page,
}) => {
  await fixture(page, { image: true });
  for (const name of ["X axis options", "Y axis options"])
    await expect(dialog(page).getByText(name, { exact: true })).toBeHidden();
  await expect(dialog(page).getByLabel("Y scale", { exact: true })).toHaveCount(0);
  expect(await dialog(page).locator(".ce-source-list input").count()).toBe(1);
  await expect(
    dialog(page).getByRole("checkbox", { name: /eval\/samples —/ }),
  ).toBeChecked();
  // Images have no axes, smoothing, or curve styling to offer.
  for (const heading of ["Smoothing", "Appearance"])
    await expect(
      dialog(page).getByRole("heading", { name: heading, exact: true }),
    ).toBeHidden();
  await expect(
    dialog(page).getByLabel("Card width", { exact: true }),
  ).toHaveCount(0);
  await expect(
    dialog(page).getByRole("slider", { name: "Smoothing strength" }),
  ).toHaveCount(0);
  expect((await state(page)).loads).toHaveLength(0);
});

test("single settings scroll, persistent preview/actions, keyboard access and 390px layout", async ({
  page,
}, testInfo) => {
  await fixture(page, { many: true, keepFolds: true });
  await expect(
    dialog(page).getByText("1 curve(s) · 301 observations", { exact: true }),
  ).toBeVisible();
  await expect(dialog(page).getByRole("tab")).toHaveCount(0);
  // Essentials are open sections; each axis carries its own options fold;
  // everything else lives in closed folds whose header summarizes state.
  expect(
    await dialog(page).locator(".ce-settings > section.ce-panel > h3").allTextContents(),
  ).toEqual(["Chart", "Y axis", "X axis"]);
  expect(
    await dialog(page)
      .locator(".ce-settings > details.ce-fold > summary h3")
      .allTextContents(),
  ).toEqual(["Smoothing", "Appearance"]);
  expect(
    await dialog(page)
      .locator(".ce-settings details.ce-fold, .ce-settings details.ce-axis-options")
      .evaluateAll((folds) => folds.map((f) => (f as HTMLDetailsElement).open)),
  ).toEqual([false, false, false, false]);
  // Axis options sit inside their own axis section.
  for (const [heading, label] of [
    ["Y axis", "Y scale"],
    ["X axis", "X scale"],
  ])
    expect(
      await dialog(page)
        .getByLabel(label, { exact: true })
        .evaluate(
          (node) =>
            node.closest("section.ce-panel")?.querySelector("h3")?.textContent,
        ),
    ).toBe(heading);
  for (const state of await dialog(page).locator(".ce-fold-state").allTextContents())
    expect(state.trim()).not.toBe("");
  for (const label of ["Chart title", "Plot type", "Runs", "X"])
    await expect(dialog(page).getByLabel(label, { exact: true })).toBeVisible();
  for (const label of ["Y scale", "Smoothing strength", "Line width"])
    await expect(dialog(page).getByLabel(label, { exact: true })).toBeHidden();
  await openFolds(page);
  await expect(
    dialog(page).locator(".ce-settings details.ce-fold details.ce-fold"),
  ).toHaveCount(0);
  for (const label of [
    "X axis title",
    "Y axis title",
    "X scale",
    "Y bounds",
    "Smoothing strength",
    "Between observations",
    "Line width",
    "Point size",
  ]) {
    await expect(dialog(page).getByLabel(label, { exact: true })).toBeVisible();
    // One click away: inside one fold at most, never a fold within a fold.
    expect(
      await dialog(page)
        .getByLabel(label, { exact: true })
        .evaluate(
          (node) =>
            node.closest("details")?.parentElement?.closest("details")?.className ??
            null,
        ),
      label,
    ).toBe(null);
  }
  await dialog(page).getByLabel("Chart title", { exact: true }).focus();
  await page.keyboard.press("Tab");
  await expect(
    dialog(page).getByLabel("Plot type", { exact: true }),
  ).toBeFocused();
  const desktopPreview = await dialog(page)
    .locator(".ce-preview")
    .boundingBox();
  await section(page, "Appearance");
  expect(await dialog(page).locator(".ce-preview").boundingBox()).toEqual(
    desktopPreview,
  );
  await page.screenshot({ path: testInfo.outputPath("editor-preview.png") });
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(
    dialog(page).getByRole("button", { name: "Save changes", exact: true }),
  ).toBeInViewport();
  const box = await dialog(page).boundingBox();
  expect(box!.width).toBeLessThanOrEqual(390);
  await expect(dialog(page).locator(".ce-preview .u-over")).toBeInViewport();
  const mobilePreview = await dialog(page).locator(".ce-preview").boundingBox();
  await dialog(page).getByLabel("Line width", { exact: true }).fill("3");
  expect(await dialog(page).locator(".ce-preview").boundingBox()).toEqual(
    mobilePreview,
  );
  expect(
    await dialog(page).evaluate((node) => node.scrollWidth <= node.clientWidth),
  ).toBe(true);
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  await page.screenshot({ path: testInfo.outputPath("editor-mobile.png") });
});

test("style presets and individual overrides stay synchronized without touching unrelated literals", async ({
  page,
}) => {
  await fixture(page);
  await section(page, "Appearance");
  const defaults = dialog(page).locator(".ce-default-style");
  const observationsShown = () =>
    page.evaluate(() => (window as any).__editor.rendered.chart.series[2].show);
  await defaults
    .getByLabel("Curve style", { exact: true })
    .selectOption("none");
  await expect(defaults.getByLabel("Points", { exact: true })).toHaveValue(
    "true",
  );
  await expect(defaults.getByLabel("Line width", { exact: true })).toHaveValue(
    "0",
  );
  await expect.poll(observationsShown).toBe(true);
  // Leaving "No line" restores the points choice from before (off), so
  // the markers really go away.
  await defaults
    .getByLabel("Curve style", { exact: true })
    .selectOption("matched");
  await expect(defaults.getByLabel("Points", { exact: true })).toHaveValue(
    "false",
  );
  await expect.poll(observationsShown).toBe(false);
  // Points are an overlay: on top of a line, and they survive line changes.
  await defaults.getByLabel("Points", { exact: true }).selectOption("true");
  await expect.poll(observationsShown).toBe(true);
  await defaults
    .getByLabel("Curve style", { exact: true })
    .selectOption("area");
  await expect(defaults.getByLabel("Points", { exact: true })).toHaveValue(
    "true",
  );
  await defaults.getByLabel("Points", { exact: true }).selectOption("false");
  await expect.poll(observationsShown).toBe(false);
  await expect(defaults.getByLabel("Line width", { exact: true })).toHaveValue(
    "2",
  );
  await expect(
    defaults.getByLabel("Area opacity", { exact: true }),
  ).toHaveValue("0.15");
  await defaults
    .getByLabel("Curve style", { exact: true })
    .selectOption("stepped-after");
  await dialog(page).getByText("More style options", { exact: true }).click();
  await dialog(page)
    .getByRole("button", { name: /ResNet seed 1.*train\/loss/ })
    .click();
  const curve = dialog(page).locator(".ce-curve-form");
  await curve.getByLabel("Curve color", { exact: true }).fill("not-a-color");
  await dialog(page)
    .getByRole("button", { name: "Save changes", exact: true })
    .click();
  await expect(curve.getByText(/Use a color such as/)).toBeVisible();
  await curve.getByLabel("Curve color", { exact: true }).fill("#a21caf");
  await curve.getByLabel("Show this curve", { exact: true }).uncheck();
  await dialog(page)
    .getByRole("button", { name: "Save changes", exact: true })
    .click();
  const config = (await state(page)).saved[0].config;
  expect(config.style.path).toBe("stepped-after");
  expect(config.style.pathOptions.align).toBe(1);
  expect(Object.values(config.runs)).toEqual([
    expect.objectContaining({ color: "#a21caf", visible: false }),
  ]);
});

test("Central 98% changes display bounds only and manual bounds take precedence", async ({
  page,
}) => {
  await fixture(page);
  await expect
    .poll(async () => (await state(page)).plots.length)
    .toBeGreaterThan(0);
  await section(page, "Axes");
  await dialog(page)
    .getByLabel("Y auto range", { exact: true })
    .selectOption("robust");
  await expect
    .poll(async () => (await state(page)).plots.at(-1).config.yMax)
    .toBeLessThan(900);
  let plot = (await state(page)).plots.at(-1);
  expect(plot.max).toBe(900);
  expect(plot.counts).toEqual([301]);
  await dialog(page)
    .getByLabel("Y bounds", { exact: true })
    .selectOption("manual");
  await dialog(page).getByLabel("Y maximum", { exact: true }).fill("1000");
  await expect
    .poll(async () => (await state(page)).plots.at(-1).config.yMax)
    .toBe(1000);
  plot = (await state(page)).plots.at(-1);
  expect(plot.max).toBe(900);
});

test("image preview uses ImagePanel, authenticated bytes, and only chosen keys", async ({
  page,
}) => {
  await fixture(page, { image: true, imagePreview: true });
  await expect(
    dialog(page).getByLabel("Image key", { exact: true }),
  ).toHaveValue("eval/samples");
  await expect(dialog(page).locator(".image-canvas")).toHaveAttribute(
    "data-pixel-zoom",
    /.+/,
  );
  expect(
    await dialog(page)
      .getByLabel("Image key", { exact: true })
      .locator("option")
      .count(),
  ).toBe(1);
  const requests = (await state(page)).requests;
  expect(
    requests.some((request: any) =>
      request.url.includes("/images/frame-one/content"),
    ),
  ).toBe(true);
  expect(
    requests.every(
      (request: any) => request.authorization === "Bearer fixture-token",
    ),
  ).toBe(true);
  expect(
    requests.some((request: any) => request.url.includes("unchosen/content")),
  ).toBe(false);
  const play = dialog(page).getByRole("button", { name: "Play", exact: true });
  if (await play.count()) await play.click();
  await expect(dialog(page)).toBeVisible();
  expect((await state(page)).saved).toHaveLength(0);
  await page.keyboard.press("Escape");
  await expect(dialog(page)).toHaveCount(0);
});

for (const action of [
  "Cancel",
  "Escape",
  "Close editor",
  "programmatic",
  "native",
  "Save changes",
]) {
  test(`onClose runs once after removal and fallback focus: ${action}`, async ({
    page,
  }) => {
    await fixture(page, { onClose: true });
    if (action === "Escape") await page.keyboard.press("Escape");
    else if (action === "programmatic")
      await page.evaluate(() => (window as any).__editor.handle.close());
    else if (action === "native")
      await dialog(page).evaluate((node: HTMLDialogElement) => node.close());
    else
      await dialog(page)
        .getByRole("button", { name: action, exact: true })
        .click();
    await expect(dialog(page)).toHaveCount(0);
    await expect(page.locator("#current-menu")).toBeFocused();
    await page.evaluate(async () => {
      (window as any).__editor.handle.close();
      await new Promise(requestAnimationFrame);
    });
    expect(await page.evaluate(() => (window as any).__editor.closes)).toEqual([
      { dialogPresent: false, focus: "launch" },
    ]);
    expect((await state(page)).saved).toHaveLength(
      action === "Save changes" ? 1 : 0,
    );
  });
}

for (const opener of ["detached", "hidden"]) {
  test(`host onClose focuses the current menu with a ${opener} opener`, async ({
    page,
  }) => {
    await fixture(page, { onClose: true });
    await page.evaluate((opener) => {
      const launch = document.querySelector<HTMLElement>("#launch")!;
      if (opener === "detached") launch.remove();
      else launch.hidden = true;
      const summary = document.querySelector("#current-menu")!;
      summary.replaceWith(summary.cloneNode(true));
    }, opener);
    await dialog(page)
      .getByRole("button", {
        name: opener === "detached" ? "Save changes" : "Cancel",
        exact: true,
      })
      .click();
    await expect(dialog(page)).toHaveCount(0);
    await expect(page.locator("#current-menu")).toBeVisible();
    await expect(page.locator("#current-menu")).toBeFocused();
    expect(
      await page.evaluate(() => (window as any).__editor.closes),
    ).toHaveLength(1);
  });
}

test("failed save leaves the editor open without calling onClose", async ({
  page,
}) => {
  await fixture(page, { onClose: true, saveError: true });
  await dialog(page)
    .getByRole("button", { name: "Save changes", exact: true })
    .click();
  await expect(
    dialog(page).getByText(/Could not save: Storage full/),
  ).toBeVisible();
  expect(
    await page.evaluate(() => (window as any).__editor.closes),
  ).toHaveLength(0);
  await dialog(page)
    .getByRole("button", { name: "Cancel", exact: true })
    .click();
  await expect(page.locator("#current-menu")).toBeFocused();
  expect(
    await page.evaluate(() => (window as any).__editor.closes),
  ).toHaveLength(1);
});

test("plot type uses concrete names and preserves sources and interpolation across presets", async ({
  page,
}) => {
  await fixture(page);
  const type = dialog(page).getByLabel("Plot type", { exact: true });
  expect(await type.locator("option").allTextContents()).toEqual([
    "Line",
    "Scatter",
    "Area",
    "Step",
    "Image panel",
  ]);
  await expect(type).toHaveValue("line");
  await type.selectOption("scatter");
  await expect
    .poll(async () => (await state(page)).plots.at(-1)?.config.style.width)
    .toBe(0);
  let preview = (await state(page)).plots.at(-1);
  expect(preview.config.style.markers.show).toBe(true);
  expect(preview.counts).toEqual([301]);
  const drawing = await page.evaluate(() => {
    const chart = (window as any).__editor.rendered.chart;
    return {
      noLine:
        chart.series[1].paths(chart, 1, 0, chart.data[0].length - 1) === null,
      markers: chart.data[2].filter((value: number | null) => value !== null)
        .length,
    };
  });
  expect(drawing).toEqual({ noLine: true, markers: 301 });
  await section(page, "Appearance");
  await dialog(page)
    .getByLabel("Between observations", { exact: true })
    .selectOption("pchip");
  await section(page, "Data");
  await expect(type).toHaveValue("scatter");
  await type.selectOption("area");
  await expect
    .poll(async () => (await state(page)).plots.at(-1)?.config.style.fill)
    .toBe(0.15);
  // Leaving scatter turns its points off; a line overlay is a separate choice.
  expect((await state(page)).plots.at(-1).config.style.markers.show).toBe(false);
  await type.selectOption("step");
  await expect
    .poll(async () => (await state(page)).plots.at(-1)?.config.style.path)
    .toBe("stepped-after");
  await type.selectOption("scatter");
  await dialog(page)
    .getByRole("button", { name: "Save changes", exact: true })
    .click();
  const saved = (await state(page)).saved[0];
  expect(saved.config.style.width).toBe(0);
  expect(saved.config.interpolation).toBe("pchip");
  expect(saved.source).toEqual({ mode: "selected", keys: ["train/loss"] });
  await page.evaluate(() => {
    const state = (window as any).__editor;
    Object.assign(state.card, state.saved[0]);
  });
  await page.locator("#launch").click();
  await expect(
    dialog(page).getByLabel("Plot type", { exact: true }),
  ).toHaveValue("scatter");
});

test("axis titles follow metric selection until explicitly edited, without saving display defaults", async ({
  page,
}) => {
  await fixture(page);
  const title = dialog(page).getByLabel("Y axis title", { exact: true });
  await expect(title).toHaveValue("");
  await expect(title).toHaveAttribute("placeholder", "train/loss");
  await expect
    .poll(async () => (await state(page)).plots.at(-1)?.config.yLabel)
    .toBe("train/loss");
  await dialog(page)
    .getByRole("checkbox", { name: /eval\/accuracy —/ })
    .check();
  await expect(title).toHaveAttribute("placeholder", "Metric values");
  await expect
    .poll(async () => (await state(page)).plots.at(-1)?.config.yLabel)
    .toBe("Metric values");
  await title.fill("Validation score (%)");
  await dialog(page)
    .getByRole("checkbox", { name: /train\/loss —/ })
    .uncheck();
  await expect(title).toHaveValue("Validation score (%)");
  await expect
    .poll(async () => (await state(page)).plots.at(-1)?.config.yLabel)
    .toBe("Validation score (%)");
  await title.fill("");
  await expect
    .poll(async () => (await state(page)).plots.at(-1)?.config.yLabel)
    .toBe("eval/accuracy");
  await dialog(page)
    .getByRole("button", { name: "Save changes", exact: true })
    .click();
  expect((await state(page)).saved[0].config.yLabel).toBe("");
});

test("saved axis titles remain authoritative and edits replace only the conflicting title", async ({
  page,
}) => {
  await fixture(page);
  await page.keyboard.press("Escape");
  await page.evaluate(() => {
    const config = (window as any).__editor.card.config;
    config.yLabel = "Saved score";
    config.advanced.axes = [
      { label: "Recorded iterations", stroke: "navy" },
      { label: "Saved literal", size: 70 },
    ];
  });
  await page.locator("#launch").click();
  await openFolds(page);
  await expect(
    dialog(page).getByLabel("Y axis title", { exact: true }),
  ).toHaveValue("Saved literal");
  await expect
    .poll(
      async () =>
        (await state(page)).plots.at(-1)?.config.advanced.axes?.[1].label,
    )
    .toBe("Saved literal");
  await dialog(page)
    .getByLabel("Y axis title", { exact: true })
    .fill("Loss (nats)");
  await dialog(page)
    .getByRole("button", { name: "Save changes", exact: true })
    .click();
  const config = (await state(page)).saved[0].config;
  expect(config.yLabel).toBe("Loss (nats)");
  expect(config.advanced.axes).toEqual([
    { label: "Recorded iterations", stroke: "navy" },
    { size: 70 },
  ]);
});

test("shared run colors refresh open previews without fetching histories or persisting derived overrides", async ({
  page,
}) => {
  await fixture(page);
  await dialog(page)
    .getByRole("checkbox", { name: /eval\/accuracy —/ })
    .check();
  await expect
    .poll(async () => (await state(page)).plots.at(-1)?.counts.length)
    .toBe(2);
  const before = await state(page);
  const colors = Object.values(before.plots.at(-1).config.runs).map(
    (style: any) => style.color,
  );
  expect(colors).toHaveLength(2);
  expect(colors[0]).toBe(colors[1]);
  await page.evaluate(() =>
    window.dispatchEvent(new Event("nset:run-colors-changed")),
  );
  await expect
    .poll(async () => (await state(page)).plots.length)
    .toBeGreaterThan(before.plots.length);
  expect((await state(page)).loads).toHaveLength(before.loads.length);
  await dialog(page)
    .getByRole("button", { name: "Save changes", exact: true })
    .click();
  expect((await state(page)).saved[0].config.runs).toEqual({});
  const after = (await state(page)).plots.length;
  await page.evaluate(() =>
    window.dispatchEvent(new Event("nset:run-colors-changed")),
  );
  await page.waitForTimeout(200);
  expect((await state(page)).plots).toHaveLength(after);
});

test("source and style choices retain keyboard focus, irrelevant advanced errors do not block saving", async ({
  page,
}) => {
  await fixture(page);
  // Chips show what is chosen; list toggles and chip removal stay in sync
  // and keep focus where the user acted.
  const loss = dialog(page).getByRole("checkbox", { name: /train\/loss —/ });
  const chip = dialog(page).getByRole("button", {
    name: "Remove train/loss",
    exact: true,
  });
  await expect(chip).toBeVisible();
  await loss.click();
  await expect(loss).not.toBeChecked();
  await expect(loss).toBeFocused();
  await expect(chip).toHaveCount(0);
  await loss.check();
  await expect(loss).toBeFocused();
  await chip.click();
  await expect(loss).not.toBeChecked();
  await loss.check();
  await expect(loss).toBeFocused();
  await dialog(page)
    .getByLabel("Y scale", { exact: true })
    .selectOption("asinh");
  await dialog(page)
    .getByLabel("Y asinh transition", { exact: true })
    .fill("-1");
  await expect(
    dialog(page).getByLabel("Y asinh transition", { exact: true }),
  ).toHaveAttribute("aria-invalid", "true");
  await dialog(page)
    .getByLabel("Y scale", { exact: true })
    .selectOption("linear");
  await expect(
    dialog(page).getByLabel("Y asinh transition", { exact: true }),
  ).toBeHidden();
  await dialog(page).getByText("More style options", { exact: true }).click();
  await dialog(page)
    .getByRole("button", { name: /ResNet seed 1.*train\/loss/ })
    .click();
  await expect(
    dialog(page).getByRole("button", { name: /ResNet seed 1.*train\/loss/ }),
  ).toBeFocused();
  await dialog(page)
    .getByRole("button", { name: "Save changes", exact: true })
    .click();
  await expect(dialog(page)).toHaveCount(0);
  expect((await state(page)).saved).toHaveLength(1);
});

test("visible None–More slider matches shared dashboard semantics and saves endpoints", async ({
  page,
}) => {
  await fixture(page);
  await section(page, "Appearance");
  const slider = dialog(page).getByRole("slider", {
    name: "Smoothing strength",
  });
  await expect(slider).toBeVisible();
  await expect(slider).toHaveAttribute("min", "0");
  await expect(slider).toHaveAttribute("max", "100");
  await expect(slider).toHaveValue("0");
  await expect(slider).toHaveAttribute("aria-valuetext", "None");
  await expect(
    dialog(page).getByLabel("Smooth the curve", { exact: true }),
  ).toHaveCount(0);
  await expect(dialog(page).locator(".ce-smoothing-endpoints")).toHaveText(
    "NoneMore",
  );
  expect(await dialog(page).innerText()).not.toMatch(
    /α|EMA|coefficient|canonical|smoothingStrength|strengthToAlpha/i,
  );
  for (const strength of [50, 100, 0, 25.5, 100]) {
    const shared = await page.evaluate(async (strength) => {
      const { strengthToSmoothing } =
        await import("/src/dashboard-controls.ts");
      return strengthToSmoothing(strength);
    }, strength);
    await slider.fill(String(strength));
    await expect
      .poll(async () => {
        const config = (await state(page)).plots.at(-1)?.config;
        return config && { smoothing: config.smoothing, alpha: config.alpha };
      })
      .toEqual(shared);
    await expect(slider).toHaveAttribute(
      "aria-valuetext",
      strength === 0
        ? "None"
        : strength === 100
          ? "More"
          : `${Math.round(strength)}%`,
    );
  }
  expect((await state(page)).card).toEqual((await state(page)).original);
  expect((await state(page)).loads).toHaveLength(1);
  await dialog(page)
    .getByRole("button", { name: "Save changes", exact: true })
    .click();
  expect((await state(page)).saved[0].config).toMatchObject({
    smoothing: true,
    alpha: 0.01,
  });
});

for (const [smoothing, alpha] of [
  [false, 0.1],
  [true, 1],
  [true, 0.1],
  [true, 0.001],
  [true, 0.19],
] as const) {
  test(`saved smoothing ${smoothing}/${alpha} projects without rewriting the stored value`, async ({
    page,
  }) => {
    await fixture(page, { config: { smoothing, alpha } });
    const expected = await page.evaluate(
      async (config) => {
        const { smoothingToStrength } =
          await import("/src/dashboard-controls.ts");
        return smoothingToStrength(config);
      },
      { smoothing, alpha },
    );
    const slider = dialog(page).getByRole("slider", {
      name: "Smoothing strength",
    });
    expect(Number(await slider.inputValue())).toBeCloseTo(expected, 10);
    await dialog(page)
      .getByRole("button", { name: "Save changes", exact: true })
      .click();
    expect((await state(page)).saved[0].config).toMatchObject({
      smoothing,
      alpha,
    });
  });
}

test("all three X axes reset incompatible bounds and preview relative to each run start", async ({
  page,
}) => {
  await fixture(page, {
    twoOrigins: true,
    config: {
      xMin: 1,
      xMax: 100,
      xScale: "log",
      xFormat: "scientific",
      yMin: 0,
      yMax: 1000,
      advanced: {
        scales: { x: { range: [1, 100], auto: false, log: 2, dir: -1 } },
        axes: [{ splits: [1, 100], values: ["first", "last"], incrs: [1] }],
      },
    },
  });
  await section(page, "Axes");
  const axis = dialog(page).getByLabel("X", { exact: true });
  // Parameters always come first; metric choices follow (the fixture's
  // runs log other metrics too, so only the parameter group is asserted).
  expect(
    await axis.locator('optgroup[label="Parameter"] option').allTextContents(),
  ).toEqual(["Step", "Wall time", "Relative time"]);
  for (const [value, title, xEnds] of [
    [
      "timestamp",
      "Time",
      [
        [1700000001000, 1700000091000],
        [1700100001000, 1700100091000],
      ],
    ],
    [
      "relative",
      "Elapsed time",
      [
        [1000, 91000],
        [1000, 91000],
      ],
    ],
    [
      "step",
      "Step",
      [
        [0, 300],
        [0, 300],
      ],
    ],
  ] as const) {
    await axis.selectOption(`param:${value}`);
    await expect(axis).toBeFocused();
    await expect(
      dialog(page).getByLabel("X axis title", { exact: true }),
    ).toHaveAttribute("placeholder", title);
    await expect(
      dialog(page).getByLabel("X bounds", { exact: true }),
    ).toHaveValue("auto");
    await expect(
      dialog(page).getByLabel("X scale", { exact: true }),
    ).toHaveValue("linear");
    await expect
      .poll(async () => (await state(page)).plots.at(-1)?.config.axis)
      .toBe(value);
    const plot = (await state(page)).plots.at(-1);
    expect(plot.xEnds).toEqual(xEnds);
    expect(plot.counts).toEqual([301, 301]);
    expect(plot.config).toMatchObject({
      xMin: null,
      xMax: null,
      xFormat: "number",
      yMin: 0,
      yMax: 1000,
    });
    expect(plot.config.advanced.scales.x).toEqual({ dir: -1 });
    expect(plot.config.advanced.axes[0]).not.toHaveProperty("splits");
    expect(plot.config.advanced.axes[0]).not.toHaveProperty("values");
    expect(plot.config.advanced.axes[0]).not.toHaveProperty("incrs");
  }
  expect((await state(page)).loads).toHaveLength(2);
  expect((await state(page)).card).toEqual((await state(page)).original);
  await axis.selectOption("param:relative");
  await dialog(page)
    .getByRole("button", { name: "Save changes", exact: true })
    .click();
  expect((await state(page)).saved[0].config).toMatchObject({
    axis: "relative",
    xLabel: "",
    xMin: null,
    xMax: null,
  });
});

for (const resize of [false, true]) {
  test(`populated scalar preview renders at 390px ${resize ? "after desktop resize" : "on open"} and after smoothing`, async ({
    page,
  }) => {
    if (!resize) await page.setViewportSize({ width: 390, height: 844 });
    await fixture(page);
    await expect
      .poll(async () => (await state(page)).renderCount)
      .toBeGreaterThan(0);
    if (resize) {
      const before = (await state(page)).renderCount;
      await page.setViewportSize({ width: 390, height: 844 });
      await expect
        .poll(async () => (await state(page)).renderCount)
        .toBeGreaterThan(before);
    }
    await expect
      .poll(async () => (await state(page)).plots.at(-1)?.config.height)
      .toBe(240);
    await expect(dialog(page).locator(".ce-preview .u-over")).toBeVisible();
    await expect(dialog(page).locator(".ce-preview")).not.toContainText(
      "Preview unavailable",
    );
    const before = (await state(page)).renderCount;
    await dialog(page)
      .getByRole("slider", { name: "Smoothing strength" })
      .fill("50");
    await expect
      .poll(async () => (await state(page)).renderCount)
      .toBeGreaterThan(before);
    expect((await state(page)).plots.at(-1).config.smoothing).toBe(true);
    await expect(dialog(page).locator(".ce-preview .u-over")).toBeVisible();
    await expect(dialog(page).locator(".ce-preview")).not.toContainText(
      "Preview unavailable",
    );
    await expect(
      dialog(page).getByRole("button", { name: "Save changes", exact: true }),
    ).toBeInViewport();
  });
}

test("default style edits survive axis clones, preview, save and reopen", async ({
  page,
}) => {
  await fixture(page);
  for (const [axis, width, color] of [
    ["timestamp", "7", "#123456"],
    ["relative", "5", "#654321"],
  ]) {
    await dialog(page)
      .getByLabel("X", { exact: true })
      .selectOption(`param:${axis}`);
    await dialog(page).getByLabel("Line width", { exact: true }).fill(width);
    await dialog(page)
      .getByLabel("Use shared run colors", { exact: true })
      .uncheck();
    await dialog(page).getByLabel("Curve color", { exact: true }).fill(color);
    await expect
      .poll(async () => (await state(page)).plots.at(-1)?.config.style)
      .toMatchObject({ width: Number(width), color });
    await expect(dialog(page).locator(".ce-preview")).not.toContainText(
      "Preview unavailable",
    );
    await dialog(page)
      .getByRole("button", { name: "Save changes", exact: true })
      .click();
    expect((await state(page)).saved.at(-1).config).toMatchObject({
      axis,
      palette: false,
      style: { width: Number(width), color },
    });
    await page.evaluate(() => {
      const s = (window as any).__editor;
      s.card = s.saved.at(-1);
    });
    await page
      .getByRole("button", { name: "Edit loss chart", exact: true })
      .click();
    await openFolds(page);
    await expect(
      dialog(page).getByLabel("X", { exact: true }),
    ).toHaveValue(`param:${axis}`);
    await expect(
      dialog(page).getByLabel("Line width", { exact: true }),
    ).toHaveValue(width);
    await expect(
      dialog(page).getByLabel("Curve color", { exact: true }),
    ).toHaveValue(color);
    await expect(
      dialog(page).getByLabel("Use shared run colors", { exact: true }),
    ).not.toBeChecked();
  }
});

// Capture variants are test-only. B is applied only inside a retained rx worktree.
for (const viewport of [
  { width: 1440, height: 1000 },
  { width: 390, height: 844 },
]) {
  test(`preview continuity capture ${viewport.width}`, async ({
    page,
  }, testInfo) => {
    const variant = process.env.NSET_EDITOR_CAPTURE;
    test.skip(!variant, "Opt-in baseline/A/B render evidence");
    await page.setViewportSize(viewport);
    await fixture(page);
    const host = dialog(page).locator('[data-role="preview"]');
    const status = dialog(page).locator('.ce-preview [role="status"]');
    await expect(host).toHaveAttribute("data-observation-count", "301");
    const capture = async (phase: string) => {
      const geometry = await page.evaluate(() => {
        const rect = (selector: string) => {
          const element = document.querySelector(selector)!;
          const r = element.getBoundingClientRect();
          return {
            x: r.x,
            y: r.y,
            width: r.width,
            height: r.height,
            scrollWidth: element.scrollWidth,
            clientWidth: element.clientWidth,
          };
        };
        return {
          viewport: { width: innerWidth, height: innerHeight },
          documentWidth: document.documentElement.scrollWidth,
          dialog: rect(".chart-editor"),
          preview: rect(".ce-preview"),
          host: rect(".ce-preview-plot"),
          footer: rect(".ce-footer"),
          status: document.querySelector('.ce-preview [role="status"]')!
            .textContent,
          count: document
            .querySelector(".ce-preview-plot")!
            .getAttribute("data-observation-count"),
          canvases: [
            ...document.querySelectorAll(".ce-preview-plot canvas"),
          ].map((c) => {
            const canvas = c as HTMLCanvasElement;
            const bytes = canvas
              .getContext("2d")!
              .getImageData(0, 0, canvas.width, canvas.height).data;
            return {
              width: canvas.width,
              height: canvas.height,
              paintedPixels: bytes.filter((_, i) => i % 4 === 3 && bytes[i] > 0)
                .length,
            };
          }),
        };
      });
      expect(geometry.documentWidth).toBeLessThanOrEqual(viewport.width);
      expect(geometry.dialog.scrollWidth).toBeLessThanOrEqual(
        geometry.dialog.clientWidth,
      );
      await testInfo.attach(`${variant}-${phase}-geometry`, {
        body: JSON.stringify(geometry, null, 2),
        contentType: "application/json",
      });
      await page.screenshot({
        path: testInfo.outputPath(`${variant}-${phase}.png`),
        fullPage: true,
      });
      console.log(
        JSON.stringify({ kind: "capture", variant, phase, ...geometry }),
      );
    };
    await capture("ready");
    await page.evaluate(() => {
      (window as any).__editor.delay = 1600;
    });
    await dialog(page)
      .getByRole("checkbox", { name: /eval\/accuracy —/ })
      .check();
    await expect(status).toContainText(
      variant === "A"
        ? "Previous preview · updating sources"
        : "Loading complete histories",
    );
    await page.waitForTimeout(750);
    if (variant === "A")
      await expect(host).toHaveAttribute("data-observation-count", "301");
    else await expect(host).not.toHaveAttribute("data-observation-count");
    await capture("loading");
    await expect(host).toHaveAttribute("data-observation-count", "602");
    await dialog(page)
      .getByLabel("Y bounds", { exact: true })
      .selectOption("manual");
    await dialog(page).getByLabel("Y maximum", { exact: true }).fill("10");
    await expect(status).toContainText("602 observations");
    await dialog(page).getByLabel("Y minimum", { exact: true }).fill("20");
    await expect(status).toContainText(
      variant === "baseline"
        ? "Correct the highlighted fields"
        : "Previous preview · fix highlighted fields",
    );
    await page.waitForTimeout(750);
    await capture("invalid");
    await dialog(page)
      .getByRole("button", { name: "Save changes", exact: true })
      .click();
    expect((await state(page)).saved).toEqual([]);
    await dialog(page).getByLabel("Y maximum", { exact: true }).fill("30");
    await expect(status).toContainText("602 observations");
    await capture("corrected");
    await dialog(page)
      .getByRole("button", { name: "Cancel", exact: true })
      .click();
    expect((await state(page)).card).toEqual((await state(page)).original);
  });
}

test("last-good scalar content survives pending histories and invalid drafts; newest request wins", async ({
  page,
}) => {
  await fixture(page);
  const host = dialog(page).locator('[data-role="preview"]');
  const status = dialog(page).locator('.ce-preview [role="status"]');
  await expect(host).toHaveAttribute("data-observation-count", "301");
  const originalCanvas = await host.locator("canvas").first().elementHandle();
  const pixels = await originalCanvas!.evaluate((canvas: HTMLCanvasElement) =>
    canvas.toDataURL(),
  );
  await page.evaluate(() => {
    Object.assign((window as any).__editor, { delay: 1600, ignoreAbort: true });
  });
  await dialog(page)
    .getByRole("checkbox", { name: /eval\/accuracy —/ })
    .check();
  await expect(status).toHaveText("Previous preview · updating sources…");
  await dialog(page)
    .getByLabel("Chart title", { exact: true })
    .fill("New comparison");
  await page.waitForTimeout(750);
  expect(
    await originalCanvas!.evaluate((canvas: HTMLCanvasElement) => ({
      connected: canvas.isConnected,
      pixels: canvas.toDataURL(),
    })),
  ).toEqual({ connected: true, pixels });
  await expect(dialog(page).locator(".ce-preview h3")).toHaveText(
    "Training loss",
  );
  await expect(host).toHaveAttribute("data-observation-count", "301");
  // A non-cooperative old request must not overwrite the newer result or its status.
  await page.evaluate(() => {
    (window as any).__editor.delay = 0;
  });
  await dialog(page)
    .getByRole("checkbox", { name: /eval\/accuracy —/ })
    .uncheck();
  await expect(status).toHaveText("1 curve(s) · 301 observations");
  await expect(dialog(page).locator(".ce-preview h3")).toHaveText(
    "New comparison",
  );
  const renders = (await state(page)).renderCount;
  await page.waitForTimeout(1700);
  expect((await state(page)).renderCount).toBe(renders);
  await expect(status).toHaveText("1 curve(s) · 301 observations");
  await dialog(page)
    .getByLabel("Y bounds", { exact: true })
    .selectOption("manual");
  await dialog(page).getByLabel("Y maximum", { exact: true }).fill("10");
  await expect
    .poll(async () => (await state(page)).plots.at(-1).config.yMax)
    .toBe(10);
  const boundedCanvas = await host.locator("canvas").first().elementHandle();
  await dialog(page).getByLabel("Y minimum", { exact: true }).fill("20");
  await expect(status).toHaveText("Previous preview · fix highlighted fields");
  await page.waitForTimeout(750);
  expect(await boundedCanvas!.evaluate((canvas) => canvas.isConnected)).toBe(
    true,
  );
  await expect(host).toHaveAttribute("data-observation-count", "301");
  await dialog(page)
    .getByRole("button", { name: "Save changes", exact: true })
    .click();
  expect((await state(page)).saved).toEqual([]);
  await dialog(page).getByLabel("Y maximum", { exact: true }).fill("30");
  await expect(status).toHaveText("1 curve(s) · 301 observations");
  await dialog(page)
    .getByRole("button", { name: "Cancel", exact: true })
    .click();
  expect((await state(page)).card).toEqual((await state(page)).original);
  await expect(page.locator("#launch")).toBeFocused();
});

test("failed scalar replacement retains previous content with retry; empty and image transitions clear it", async ({
  page,
}) => {
  await fixture(page);
  const host = dialog(page).locator('[data-role="preview"]');
  const status = dialog(page).locator('.ce-preview [role="status"]');
  await expect(host).toHaveAttribute("data-observation-count", "301");
  const canvas = await host.locator("canvas").first().elementHandle();
  await page.evaluate(() => {
    (window as any).__editor.failLoads = true;
  });
  await dialog(page)
    .getByRole("checkbox", { name: /eval\/accuracy —/ })
    .check();
  await expect(status).toHaveText(
    "Previous preview · update unavailable: History offline",
  );
  expect(await canvas!.evaluate((node) => node.isConnected)).toBe(true);
  await page.evaluate(() => {
    (window as any).__editor.failLoads = false;
  });
  await dialog(page).getByRole("button", { name: /Retry/ }).click();
  await expect(status).toHaveText("2 curve(s) · 602 observations");
  expect((await state(page)).plots.at(-1).counts).toEqual([301, 301]);
  await dialog(page)
    .getByRole("checkbox", { name: /eval\/accuracy —/ })
    .uncheck();
  await dialog(page)
    .getByRole("checkbox", { name: /train\/loss —/ })
    .uncheck();
  await expect(status).toHaveText("Choose a source in Data to see a preview.");
  await expect(host.locator("canvas")).toHaveCount(0);
  await expect(host).not.toHaveAttribute("data-observation-count");
  await dialog(page)
    .getByRole("checkbox", { name: /train\/loss —/ })
    .check();
  await expect(host).toHaveAttribute("data-observation-count", "301");
  await dialog(page)
    .getByLabel("Plot type", { exact: true })
    .selectOption("image");
  await expect(host.locator("canvas")).toHaveCount(0);
  await expect(host).not.toHaveAttribute("data-observation-count");
  await expect(status).not.toContainText("Previous preview");
  await dialog(page)
    .getByRole("button", { name: "Cancel", exact: true })
    .click();
  expect((await state(page)).saved).toEqual([]);
});

for (const action of ["Cancel", "Escape"]) {
  test(`${action} aborts pending replacement while retaining scalar content and saves nothing`, async ({
    page,
  }) => {
    await fixture(page);
    const host = dialog(page).locator('[data-role="preview"]');
    await expect(host).toHaveAttribute("data-observation-count", "301");
    await page.evaluate(() => {
      (window as any).__editor.delay = 3000;
    });
    await dialog(page)
      .getByRole("checkbox", { name: /eval\/accuracy —/ })
      .check();
    await expect(
      dialog(page).locator('.ce-preview [role="status"]'),
    ).toHaveText("Previous preview · updating sources…");
    await expect(host).toHaveAttribute("data-observation-count", "301");
    if (action === "Escape") await page.keyboard.press("Escape");
    else
      await dialog(page)
        .getByRole("button", { name: action, exact: true })
        .click();
    await expect(dialog(page)).toHaveCount(0);
    expect((await state(page)).aborted.sort()).toEqual([
      "eval/accuracy",
      "train/loss",
    ]);
    expect((await state(page)).saved).toEqual([]);
    expect((await state(page)).card).toEqual((await state(page)).original);
    await expect(page.locator("#launch")).toBeFocused();
  });
}

for (const scenario of [
  { name: "automatic", config: {}, applies: true },
  {
    name: "one-sided manual",
    config: { yMax: 1000 },
    applies: false,
    reason: "manual limits",
  },
  {
    name: "two-sided manual",
    config: { yMin: 0, yMax: 1000 },
    applies: false,
    reason: "manual limits",
  },
  {
    name: "advanced manual",
    config: { advanced: { scales: { y: { range: [null, 1000], dir: -1 } } } },
    applies: false,
    reason: "manual limits",
  },
  {
    name: "custom range",
    config: {
      advanced: {
        scales: {
          y: { range: { min: { hard: 0 }, max: { soft: 1000 } }, dir: -1 },
        },
      },
    },
    applies: false,
    reason: "custom range rules",
  },
  { name: "constant values", config: {}, constant: true, applies: false },
]) {
  test(`effective robust-range feedback: ${scenario.name}`, async ({
    page,
  }, testInfo) => {
    await fixture(page, {
      config: scenario.config,
      constant: scenario.constant,
    });
    const status = dialog(page).locator('.ce-preview [role="status"]');
    const policy = dialog(page).getByLabel("Y auto range", { exact: true });
    await expect(status).toHaveText("1 curve(s) · 301 observations");
    const before = (await state(page)).plots.at(-1).config;
    await expect(policy).toBeEnabled();
    if (scenario.reason)
      await expect(
        dialog(page).getByText(
          `Saved for automatic bounds; ${scenario.reason} are active.`,
          { exact: true },
        ),
      ).toBeVisible();
    const renders = (await state(page)).renderCount;
    await policy.selectOption("robust");
    await expect
      .poll(async () => (await state(page)).renderCount)
      .toBeGreaterThan(renders);
    await expect(status).toHaveText(
      `1 curve(s) · 301 observations${scenario.applies ? " · Central 98% display" : ""}`,
    );
    const current = (await state(page)).plots.at(-1);
    expect(current.counts).toEqual([301]);
    if (scenario.applies) {
      expect(current.config.yMin).not.toBeNull();
      expect(current.config.yMax).toBeLessThan(3);
    } else {
      expect(current.config).toEqual(before);
    }
    if (process.env.NSET_EDITOR_CAPTURE)
      await page.screenshot({
        path: testInfo.outputPath("effective-range.png"),
        fullPage: true,
      });
    await dialog(page)
      .getByRole("button", { name: "Save changes", exact: true })
      .click();
    const result = await state(page);
    expect(result.saved[0].outliers).toBe("robust");
    expect(result.saved[0].config).toEqual(result.original.config);
    expect(result.card).toEqual(result.original);
    expect(result.loads).toHaveLength(1);
  });
}

test("automatic bounds reactivate the saved robust policy without reloading histories", async ({
  page,
}) => {
  await fixture(page, { config: { yMax: 1000 } });
  const status = dialog(page).locator('.ce-preview [role="status"]');
  const policy = dialog(page).getByLabel("Y auto range", { exact: true });
  await expect(status).toHaveText("1 curve(s) · 301 observations");
  await policy.selectOption("robust");
  await dialog(page)
    .getByLabel("Y bounds", { exact: true })
    .selectOption("auto");
  await expect(policy).toHaveValue("robust");
  await expect(status).toHaveText(
    "1 curve(s) · 301 observations · Central 98% display",
  );
  await expect(
    dialog(page).getByText(/Saved for automatic bounds;/),
  ).toHaveCount(0);
  await policy.selectOption("all");
  await expect(status).toHaveText("1 curve(s) · 301 observations");
  expect((await state(page)).plots.at(-1).config.yMax).toBeNull();
  expect((await state(page)).plots.at(-1).max).toBe(900);
  expect((await state(page)).loads).toHaveLength(1);
});

test("reused scalar preview reports current unavailable-source warnings", async ({
  page,
}) => {
  await fixture(page, { explicit: true });
  await dialog(page)
    .getByRole("checkbox", { name: /train\/loss —/ })
    .check();
  const status = dialog(page).locator('.ce-preview [role="status"]');
  await expect(status).toHaveText("1 curve(s) · 301 observations");
  await expect(dialog(page).locator(".ce-preview")).toContainText(
    "1 source(s) unavailable.",
  );
  await dialog(page)
    .getByRole("checkbox", { name: /old\/loss/ })
    .click();
  await expect(dialog(page).getByRole("checkbox", { name: /old\/loss/ })).toHaveCount(0);
  await dialog(page)
    .getByRole("checkbox", { name: /eval\/accuracy —/ })
    .check();
  await expect(status).toHaveText("2 curve(s) · 602 observations");
  await expect(dialog(page).locator(".ce-preview")).not.toContainText(
    "unavailable",
  );
});

test("full editor journey cancels unchanged, then saves exact sources, range, and smoothing", async ({
  page,
}) => {
  await fixture(page);
  const original = (await state(page)).original;
  const status = () => dialog(page).locator('.ce-preview [role="status"]');
  for (const action of ["Cancel", "Save changes"]) {
    await expect(status()).toHaveText("1 curve(s) · 301 observations");
    await dialog(page)
      .getByRole("checkbox", { name: /eval\/accuracy —/ })
      .check();
    await expect(status()).toHaveText("2 curve(s) · 602 observations");
    await dialog(page)
      .getByLabel("Y scale", { exact: true })
      .selectOption("log");
    await dialog(page)
      .getByLabel("Y bounds", { exact: true })
      .selectOption("manual");
    await dialog(page).getByLabel("Y minimum", { exact: true }).fill("0.1");
    await dialog(page).getByLabel("Y maximum", { exact: true }).fill("1000");
    await dialog(page)
      .getByRole("slider", { name: "Smoothing strength" })
      .fill("50");
    await expect
      .poll(async () => (await state(page)).plots.at(-1).config.yMax)
      .toBe(1000);
    await page.evaluate(() => {
      (window as any).__editor.delay = 1000;
    });
    await dialog(page)
      .getByRole("checkbox", { name: /train\/loss —/ })
      .uncheck();
    await expect(status()).toHaveText("Previous preview · updating sources…");
    await expect(dialog(page).locator('[data-role="preview"]')).toHaveAttribute(
      "data-observation-count",
      "602",
    );
    await expect(status()).toHaveText("1 curve(s) · 301 observations");
    const expected = (await state(page)).plots.at(-1).config;
    await dialog(page)
      .getByRole("button", { name: action, exact: true })
      .click();
    expect((await state(page)).card).toEqual(original);
    if (action === "Cancel") {
      expect((await state(page)).saved).toEqual([]);
      await page.evaluate(() => {
        (window as any).__editor.delay = 0;
      });
      await page.locator("#launch").click();
      await openFolds(page);
      await expect(
        dialog(page).getByLabel("Y scale", { exact: true }),
      ).toHaveValue(original.config.yScale);
      await expect(
        dialog(page).getByRole("slider", { name: "Smoothing strength" }),
      ).toHaveValue("0");
    } else {
      const saved = (await state(page)).saved[0];
      expect(saved.source).toEqual({
        mode: "selected",
        keys: ["eval/accuracy"],
      });
      expect(saved.config.yScale).toBe("log");
      expect(saved.config.yMin).toBe(0.1);
      expect(saved.config.yMax).toBe(1000);
      expect(saved.config.smoothing).toBe(expected.smoothing);
      expect(saved.config.alpha).toBe(expected.alpha);
      // Emulate the host persisting its successful Save result before reopening.
      await page.evaluate(() => {
        const state = (window as any).__editor;
        Object.assign(state.card, state.saved[0]);
        state.delay = 0;
      });
      await page.locator("#launch").click();
      await openFolds(page);
      await expect(
        dialog(page).getByLabel("Y minimum", { exact: true }),
      ).toHaveValue("0.1");
      await expect(
        dialog(page).getByLabel("Y maximum", { exact: true }),
      ).toHaveValue("1000");
      await expect(
        dialog(page).getByRole("slider", { name: "Smoothing strength" }),
      ).toHaveValue("50");
      await expect(status()).toHaveText("1 curve(s) · 301 observations");
      expect((await state(page)).card).toEqual(saved);
    }
  }
});

test("scrolling inside the editor never scrolls the page behind it", async ({ page }) => {
  await fixture(page, { many: true });
  await page.evaluate(() => {
    const filler = document.createElement("div");
    filler.style.height = "5000px";
    document.body.append(filler);
    window.scrollTo(0, 0);
  });
  expect(
    await page.evaluate(() => document.documentElement.scrollHeight > innerHeight * 2),
  ).toBe(true);
  const settings = dialog(page).locator(".ce-settings");
  const targets = [
    settings,
    dialog(page).locator(".ce-header"),
    dialog(page).locator(".ce-preview"),
  ];
  for (const target of targets) {
    for (const dy of [4000, -4000, 4000]) {
      await target.hover();
      await page.mouse.wheel(0, dy);
      await page.waitForTimeout(80);
    }
    expect(await page.evaluate(() => window.scrollY)).toBe(0);
  }
  // The settings column itself still scrolls.
  const [scrollH, clientH] = await settings.evaluate((n) => [n.scrollHeight, n.clientHeight]);
  if (scrollH > clientH + 10) {
    await settings.hover();
    await page.mouse.wheel(0, 300);
    await expect.poll(() => settings.evaluate((n) => n.scrollTop)).toBeGreaterThan(0);
  }
  expect(await page.evaluate(() => window.scrollY)).toBe(0);
});
