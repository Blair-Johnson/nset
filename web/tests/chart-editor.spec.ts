import { test, expect, type Page } from "@playwright/test";

type FixtureOptions = {
  empty?: boolean;
  explicit?: boolean;
  image?: boolean;
  delayed?: boolean;
  advanced?: boolean;
  saveError?: boolean;
  many?: boolean;
  imagePreview?: boolean;
  onClose?: boolean;
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
    const state: any = {
      closes: [],
      plots: [],
      requests: [],
      card,
      original: structuredClone(card),
      saved: [],
      loads: [],
      aborted: [],
      rejectSave: !!options.saveError,
    };
    const store = {
      clear() {},
      load(ref: any, signal?: AbortSignal) {
        state.loads.push(ref);
        const points = Array.from({ length: 301 }, (_, i) => ({
          seq: i,
          step: i,
          timestamp: 1000 + i * i,
          value: i === 177 ? 900 : 1 + Math.exp(-i / 100),
        }));
        if (!options.delayed) return Promise.resolve(points);
        return new Promise((resolve, reject) => {
          const timer = setTimeout(() => resolve(points), 3000);
          signal?.addEventListener(
            "abort",
            () => {
              clearTimeout(timer);
              state.aborted.push(ref.key);
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
      state.plots.push({
        config: structuredClone(config),
        counts: data.map((series: any) => series.count),
        max: Math.max(
          ...data.flatMap((series: any) =>
            series.observations.map((point: any) => point[1]),
          ),
        ),
      });
      return originalRender.call(this, data, config, pins);
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
}
const dialog = (page: Page) => page.getByRole("dialog", { name: "Edit chart" });
const section = (page: Page, name: string) =>
  dialog(page).getByRole("tab", { name, exact: true }).click();
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
  expect(await dialog(page).innerText()).not.toMatch(/raw-derived|raw observations|canonical|authoritative/i);
  await dialog(page)
    .getByLabel("Chart title", { exact: true })
    .fill("Draft only");
  await section(page, "Appearance");
  await dialog(page).getByLabel("Smooth the curve", { exact: true }).check();
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
  await dialog(page)
    .getByText("Labels & more options", { exact: true })
    .first()
    .click();
  await expect(dialog(page).getByLabel("X label", { exact: true })).toHaveValue(
    "Saved step",
  );
  await expect(
    dialog(page).getByLabel("X number format", { exact: true }),
  ).toHaveValue("scientific");
  await dialog(page).getByLabel("X label", { exact: true }).fill("Iteration");
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
  await dialog(page).getByLabel("Smooth the curve", { exact: true }).check();
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
  await expect(
    dialog(page).getByRole("tab", { name: "Axes", exact: true }),
  ).toBeDisabled();
  expect(await dialog(page).locator(".ce-source-list input").count()).toBe(1);
  await expect(
    dialog(page).getByRole("checkbox", { name: /eval\/samples —/ }),
  ).toBeChecked();
  await section(page, "Appearance");
  await expect(
    dialog(page).getByLabel("Card width", { exact: true }),
  ).toBeVisible();
  await expect(
    dialog(page).getByLabel("Smooth the curve", { exact: true }),
  ).toHaveCount(0);
  expect((await state(page)).loads).toHaveLength(0);
});

test("keyboard tab navigation, small viewport and component screenshot", async ({
  page,
}, testInfo) => {
  await fixture(page, { many: true });
  await expect(
    dialog(page).getByText("1 curve(s) · 301 observations", { exact: true }),
  ).toBeVisible();
  await dialog(page).getByRole("tab", { name: "Data", exact: true }).focus();
  await page.keyboard.press("ArrowRight");
  await expect(
    dialog(page).getByRole("tab", { name: "Axes", exact: true }),
  ).toBeFocused();
  await page.screenshot({ path: testInfo.outputPath("editor-preview.png") });
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(
    dialog(page).getByRole("button", { name: "Save changes", exact: true }),
  ).toBeInViewport();
  const box = await dialog(page).boundingBox();
  expect(box!.width).toBeLessThanOrEqual(390);
  await page.screenshot({ path: testInfo.outputPath("editor-mobile.png") });
});

test("style presets and individual overrides stay synchronized without touching unrelated literals", async ({
  page,
}) => {
  await fixture(page);
  await section(page, "Appearance");
  await dialog(page).getByText("Default curve style", { exact: true }).click();
  const defaults = dialog(page)
    .locator("details")
    .filter({
      has: page.locator("summary", { hasText: /^Default curve style$/ }),
    })
    .first();
  await defaults
    .getByLabel("Curve style", { exact: true })
    .selectOption("points");
  await expect(
    defaults.getByLabel("Observation points", { exact: true }),
  ).toHaveValue("true");
  await defaults.getByText("Line & marker details", { exact: true }).click();
  await expect(defaults.getByLabel("Line width", { exact: true })).toHaveValue(
    "0",
  );
  await defaults
    .getByLabel("Curve style", { exact: true })
    .selectOption("area");
  await expect(defaults.getByLabel("Line width", { exact: true })).toHaveValue(
    "2",
  );
  await expect(
    defaults.getByLabel("Area opacity", { exact: true }),
  ).toHaveValue("0.15");
  await defaults
    .getByLabel("Curve style", { exact: true })
    .selectOption("stepped-before");
  await dialog(page).getByText("Individual curves", { exact: true }).click();
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
  expect(config.style.path).toBe("stepped-before");
  expect(config.style.pathOptions.align).toBe(-1);
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
