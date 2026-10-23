import { test, expect, type Page } from "@playwright/test";

async function fixture(page: Page) {
  await page.route(new RegExp("^http://127\\.0\\.0\\.1:[0-9]+/$"), (route) =>
    route.fulfill({
      contentType: "text/html",
      body: "<!doctype html><html><body></body></html>",
    }),
  );
  await page.goto("/");
  await page.evaluate(async () => {
    const { ChartCard } = await import("/src/cards.ts");
    const { newChart } = await import("/src/workspace.ts");
    const { MetricStore } = await import("/src/catalog.ts");
    const { Api } = await import("/src/api.ts");
    document.body.style.cssText =
      "margin:24px;background:#f7f9fc;font:14px system-ui;min-height:2000px";
    const grid = document.createElement("main");
    grid.style.cssText =
      "display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:18px;max-width:1400px";
    document.body.append(grid);
    const run = (id: string) => ({
      id,
      name: `Run ${id}`,
      experiment_id: "e",
      status: "finished",
      params: {},
      tags: {},
      created_at: 0,
      updated_at: 100,
    });
    const catalog = {
      experiments: [{ id: "e", name: "Training", created_at: 0 }],
      runs: [run("r1"), run("r2")],
      series: [] as any[],
    };
    for (const run_id of ["r1", "r2"])
      for (const [kind, keys] of [
        ["metric", ["train/loss", "train/accuracy"]],
        ["image", ["train/input", "train/output"]],
      ] as const) {
        for (const key of keys)
          catalog.series.push({
            run_id,
            key,
            kind,
            count: kind === "metric" ? 101 : 3,
            last_step: 100,
            last_timestamp: 100,
            last_value: kind === "metric" ? 1 : null,
          });
      }
    const canvas = document.createElement("canvas");
    canvas.width = 640;
    canvas.height = 320;
    const drawing = canvas.getContext("2d")!;
    drawing.fillStyle = "#437cc0";
    drawing.fillRect(0, 0, 320, 320);
    drawing.fillStyle = "#db9560";
    drawing.fillRect(320, 0, 320, 320);
    const blob: Blob = await new Promise((resolve) =>
      canvas.toBlob((blob) => resolve(blob!), "image/png"),
    );
    const requests: any[] = [];
    const api = new Api(
      () => "cards-secret",
      async (path: string, init: RequestInit) => {
        requests.push({
          path,
          auth: (init.headers as any).Authorization,
          signal: init.signal,
        });
        const url = new URL(path, location.href);
        const runId = url.pathname.split("/")[3];
        if (url.pathname.endsWith("/metrics")) {
          const key = url.searchParams.get("key");
          const points = Array.from({ length: 101 }, (_, i) => ({
            seq: i + 1,
            step: i,
            timestamp: 1700000000000 + i * 1000,
            value:
              key === "train/loss" ? (i === 50 ? 100000 : i) : (100 - i) / 100,
          }));
          return Response.json({
            points,
            next_after: null,
            snapshot: 101,
            total: 101,
          });
        }
        if (url.pathname.endsWith("/images"))
          return Response.json({
            images: ["train/input", "train/output"].flatMap((key) =>
              [0, 1, 2].map((step) => ({
                id: `${runId}-${key.replace("/", "-")}-${step}`,
                run_id: runId,
                key,
                step,
                timestamp: 1700000000000 + step,
                content_type: "image/png",
                byte_length: blob.size,
              })),
            ),
          });
        if (url.pathname.endsWith("/content"))
          return new Response(blob, {
            headers: { "Content-Type": "image/png" },
          });
        throw Error(`Unexpected API path ${path}`);
      },
    );
    const context = {
      api,
      catalog,
      selectedRunIds: ["r1"],
      store: new MetricStore(api),
    };
    const events: any[] = [];
    const actions = {
      onEdit: (id: string) => events.push(["edit", id]),
      onDuplicate: (id: string) => events.push(["duplicate", id]),
      onRemove: (id: string) => events.push(["remove", id]),
      onResize: (id: string, size: string) => events.push(["resize", id, size]),
      onMove: (id: string, delta: number) => events.push(["move", id, delta]),
    };
    const specs = [
      newChart(
        "timeseries",
        ["train/loss", "train/accuracy"],
        "Training curves",
      ),
      newChart("timeseries", ["train/accuracy"], "Accuracy"),
      newChart("image", ["train/input"], "Input images"),
      newChart("image", ["train/output"], "Output images"),
    ];
    specs.forEach((spec: any, index: number) => {
      spec.id = `card-${index}`;
    });
    const cards = specs.map((spec: any) => {
      const host = document.createElement("div");
      grid.append(host);
      return new ChartCard(host, spec, context, actions);
    });
    (window as any).cardsFixture = {
      cards,
      specs,
      context,
      actions,
      requests,
      events,
      ChartCard,
      grid,
    };
  });
  await expect(page.locator('[data-card-id="card-0"] .u-over')).toBeVisible();
  await expect(page.locator('[data-card-id="card-2"] .frame-info')).toHaveText(
    "Step 0 · 1 / 3",
  );
  await expect(page.locator('[data-card-id="card-3"] .frame-info')).toHaveText(
    "Step 0 · 1 / 3",
  );
}
const card = (page: Page, id: number) =>
  page.locator(`[data-card-id="card-${id}"]`);

test("mixed cards and two image viewers stay independent, authenticated and native-resolution", async ({
  page,
}, testInfo) => {
  await fixture(page);
  expect(await page.locator("[id]").count()).toBe(0);
  await card(page, 0).getByText("Show legend", { exact: true }).click();
  await expect(
    card(page, 0)
      .getByRole("list", { name: "Chart series" })
      .getByRole("listitem"),
  ).toHaveCount(2);
  expect(await card(page, 0).innerText()).not.toMatch(
    /raw-derived|raw observations|canonical|authoritative/i,
  );

  await card(page, 2)
    .getByRole("button", { name: "Next →", exact: true })
    .click();
  await expect(card(page, 2).locator(".frame-info")).toHaveText(
    "Step 1 · 2 / 3",
  );
  await expect(card(page, 3).locator(".frame-info")).toHaveText(
    "Step 0 · 1 / 3",
  );
  await card(page, 2)
    .getByRole("button", { name: "1:1 pixels", exact: true })
    .click();
  await expect
    .poll(() =>
      card(page, 2)
        .locator("[data-role=image-viewer]")
        .getAttribute("data-pixel-zoom"),
    )
    .toBe("1");
  const zoom = await card(page, 2)
    .locator("[data-role=image-viewer]")
    .getAttribute("data-zoom");
  await card(page, 2)
    .getByRole("button", { name: "Next →", exact: true })
    .click();
  await expect(card(page, 2).locator(".frame-info")).toHaveText(
    "Step 2 · 3 / 3",
  );
  await expect(
    card(page, 2).locator("[data-role=image-viewer]"),
  ).toHaveAttribute("data-zoom", zoom!);
  const sourceKeys = await page.evaluate(() => {
    const s = (window as any).cardsFixture;
    return [
      s.cards[2].images.frames.map((f: any) => f.key),
      s.cards[3].images.frames.map((f: any) => f.key),
      s.requests.every(
        (r: any) =>
          r.auth === "Bearer cards-secret" && r.signal instanceof AbortSignal,
      ),
    ];
  });
  expect(sourceKeys).toEqual([
    ["train/input", "train/input", "train/input"],
    ["train/output", "train/output", "train/output"],
    true,
  ]);
  await page.screenshot({
    path: testInfo.outputPath("mixed-cards.png"),
    fullPage: false,
  });
  const imageIdentity = await page.evaluate(() => {
    const s = (window as any).cardsFixture,
      c = s.cards[2],
      image = c.images,
      count = s.requests.length;
    c.setSpec({ ...c.spec, layout: { width: 680, height: 550 } });
    return image === c.images && s.requests.length === count;
  });
  expect(imageIdentity).toBe(true);
  await expect(
    card(page, 2).getByRole("button", { name: "Resize chart", exact: true }),
  ).toHaveCount(0);
  await expect
    .poll(() =>
      page.evaluate(() => {
        const v = (window as any).cardsFixture.cards[2].images.viewer;
        return v.viewport.getContainerSize().y === v.container.clientHeight;
      }),
    )
    .toBe(true);
  const cameraBeforeMaximize = await card(page, 2)
    .locator("[data-role=image-viewer]")
    .getAttribute("data-zoom");
  const imageBefore = await card(page, 2)
    .locator(".image-canvas")
    .boundingBox();
  await page.evaluate(() => {
    const s = (window as any).cardsFixture;
    s.imagePanel = s.cards[2].images;
  });
  await card(page, 2)
    .getByRole("button", { name: "Maximize chart", exact: true })
    .click();
  await expect(
    card(page, 2).getByRole("slider", { name: "Image frame timeline" }),
  ).toBeVisible();
  await expect(card(page, 2).locator(".image-canvas")).toBeVisible();
  await expect
    .poll(
      async () =>
        (await card(page, 2).locator(".image-canvas").boundingBox())!.height,
    )
    .toBeGreaterThan(900);
  await page.keyboard.press("Escape");
  await expect(card(page, 2).locator(".card-maximized")).toHaveCount(0);
  await expect
    .poll(
      async () =>
        (await card(page, 2).locator(".image-canvas").boundingBox())!.height,
    )
    .toBe(imageBefore!.height);
  expect(
    await page.evaluate(() => {
      const s = (window as any).cardsFixture;
      return s.imagePanel === s.cards[2].images;
    }),
  ).toBe(true);
  await expect(
    card(page, 2).locator("[data-role=image-viewer]"),
  ).toHaveAttribute("data-zoom", cameraBeforeMaximize!);
});

test("scalar cursor modes are local, A/B values use both metrics from one run and threshold lists all crossings", async ({
  page,
}) => {
  await fixture(page);
  const first = card(page, 0);
  await expect(first.locator(".card-inspection")).toBeHidden();
  await first
    .getByRole("button", { name: "Add vertical cursor", exact: true })
    .click();
  await expect(
    first.getByRole("button", { name: "Add vertical cursor", exact: true }),
  ).toHaveAttribute("aria-pressed", "true");
  await expect(card(page, 1).locator(".card-inspection")).toBeHidden();
  await first.getByText("Edit positions", { exact: true }).click();
  await first
    .getByRole("spinbutton", { name: "Cursor A coordinate" })
    .fill("49");
  await first
    .getByRole("spinbutton", { name: "Cursor A coordinate" })
    .press("Tab");
  await first
    .getByRole("spinbutton", { name: "Cursor B coordinate" })
    .fill("50");
  await first
    .getByRole("spinbutton", { name: "Cursor B coordinate" })
    .press("Tab");
  await expect(first.locator(".card-value-table tr")).toHaveCount(3);
  await expect(first.locator(".card-value-table")).toContainText("100000");
  expect(
    await page.evaluate(() => {
      const data = (window as any).cardsFixture.cards[0].data;
      return new Set(data.map((s: any) => s.run.id)).size;
    }),
  ).toBe(2);
  await first
    .getByRole("button", { name: "Add horizontal cursor", exact: true })
    .click();
  await first.getByText("Edit positions", { exact: true }).click();
  await first.getByRole("spinbutton", { name: "Cursor A level" }).fill("50000");
  await first.getByRole("spinbutton", { name: "Cursor A level" }).press("Tab");
  await expect(
    first.locator(".card-crossings").first().locator("summary"),
  ).toContainText("2 crossings");
  await first.getByText("Per-run values / crossings", { exact: true }).click();
  await first.locator(".card-crossings").first().locator("summary").click();
  await expect(
    first.locator(".card-crossings").first().locator("div"),
  ).not.toHaveText("No crossings");
  await first
    .getByRole("button", { name: "Clear cursors", exact: true })
    .click();
  await expect(first.locator(".card-inspection")).toBeHidden();
});

test("card actions and configuration do not mutate neighboring cards", async ({
  page,
}) => {
  await fixture(page);
  const first = card(page, 0);
  await first.getByLabel("Chart actions", { exact: true }).click();
  await first.getByRole("button", { name: "Edit chart", exact: true }).click();
  await first.getByLabel("Chart actions", { exact: true }).click();
  await expect(
    first.getByRole("button", { name: "Wide", exact: true }),
  ).toHaveCount(0);
  await first.getByRole("button", { name: "Move down", exact: true }).click();
  expect(
    await page.evaluate(() => (window as any).cardsFixture.events),
  ).toEqual([
    ["edit", "card-0"],
    ["move", "card-0", 1],
  ]);
  await page.evaluate(() => {
    const s = (window as any).cardsFixture;
    s.cards[0].setSpec({
      ...s.specs[0],
      config: { ...s.specs[0].config, yMin: 20, yMax: 80 },
    });
  });
  await expect
    .poll(() =>
      page.evaluate(
        () => (window as any).cardsFixture.cards[0].plot.viewport()?.y,
      ),
    )
    .toEqual([20, 80]);
  expect(
    await page.evaluate(
      () => (window as any).cardsFixture.cards[1].spec.config.yMin,
    ),
  ).toBeNull();
});

test("central 98% only clips the viewport; spike inspection and manual bounds survive", async ({
  page,
}) => {
  await fixture(page);
  await page.evaluate(() => {
    const s = (window as any).cardsFixture;
    s.cards[0].setSpec({
      ...s.specs[0],
      source: { mode: "selected", keys: ["train/loss"] },
      outliers: "robust",
    });
  });
  await expect(card(page, 0).locator(".card-clipping")).toContainText(
    "Central 98%",
  );
  expect(
    await page.evaluate(() => {
      const c = (window as any).cardsFixture.cards[0];
      return [
        c.data[0].points.length,
        c.data[0].fn.at(50),
        c.plot.viewport().y[1],
      ];
    }),
  ).toEqual([101, 100000, 100]);
  await card(page, 0)
    .getByRole("button", { name: "Show all values in this view" })
    .click();
  expect(
    await page.evaluate(
      () => (window as any).cardsFixture.cards[0].plot.viewport().y[1],
    ),
  ).toBeGreaterThanOrEqual(100000);
  await page.evaluate(() => {
    const s = (window as any).cardsFixture;
    s.cards[0].setSpec({
      ...s.cards[0].spec,
      config: { ...s.specs[0].config, yMin: 10, yMax: 30 },
    });
  });
  await expect
    .poll(() =>
      page.evaluate(
        () => (window as any).cardsFixture.cards[0].plot.viewport()?.y,
      ),
    )
    .toEqual([10, 30]);
  await expect(card(page, 0).locator(".card-clipping")).toBeEmpty();
});

test("normal image wheel scrolls dashboard, Alt wheel zooms intentionally", async ({
  page,
}) => {
  await fixture(page);
  const canvas = card(page, 2).locator("[data-role=image-viewer]");
  await canvas.scrollIntoViewIfNeeded();
  const zoom = await canvas.getAttribute("data-zoom");
  await canvas.hover();
  await page.mouse.wheel(0, 100);
  await expect
    .poll(() => page.evaluate(() => window.scrollY))
    .toBeGreaterThan(0);
  await expect(canvas).toHaveAttribute("data-zoom", zoom!);
  await canvas.hover();
  await page.keyboard.down("Alt");
  await page.mouse.wheel(0, -100);
  await page.keyboard.up("Alt");
  await expect.poll(() => canvas.getAttribute("data-zoom")).not.toBe(zoom);
});

test("context changes cancel stale scalar loads and errors clear previous data", async ({
  page,
}) => {
  await fixture(page);
  await page.evaluate(() => {
    const s = (window as any).cardsFixture;
    s.pending = [];
    const store = {
      clear() {},
      load(ref: any, signal: AbortSignal) {
        return new Promise((resolve) =>
          s.pending.push({ ref, signal, resolve }),
        );
      },
    };
    s.cards[0].setContext({ ...s.context, store });
  });
  await expect(card(page, 0).locator(".u-over")).toHaveCount(0);
  await page.evaluate(() => {
    const s = (window as any).cardsFixture;
    s.cards[0].setContext({ ...s.context, selectedRunIds: ["r2"] });
    for (const pending of s.pending)
      pending.resolve([{ seq: 1, step: 0, timestamp: 0, value: -999 }]);
  });
  await expect(card(page, 0).locator(".u-over")).toBeVisible();
  expect(
    await page.evaluate(() => {
      const s = (window as any).cardsFixture;
      return [
        s.pending.every((p: any) => p.signal.aborted),
        s.cards[0].data.every((d: any) => d.run.name.includes("r2")),
      ];
    }),
  ).toEqual([true, true]);
  await page.evaluate(() => {
    const s = (window as any).cardsFixture;
    s.cards[0].setContext({
      ...s.context,
      store: {
        clear() {},
        async load() {
          throw Error("Connection lost");
        },
      },
    });
  });
  await expect(card(page, 0).getByRole("status")).toContainText(
    "Could not load chart: Connection lost",
  );
  await expect(card(page, 0).locator(".u-over")).toHaveCount(0);
});

test("offscreen and inactive cards defer loads, unavailable sources stay explicit, destroy cancels", async ({
  page,
}) => {
  await fixture(page);
  await page.evaluate(() => {
    const s = (window as any).cardsFixture;
    const host = document.createElement("div");
    host.style.cssText = "position:absolute;top:6000px;width:600px";
    document.body.append(host);
    s.lazyCalls = [];
    s.lazy = new s.ChartCard(
      host,
      { ...s.specs[0], id: "lazy" },
      {
        ...s.context,
        store: {
          clear() {},
          load(ref: any, signal: AbortSignal) {
            s.lazyCalls.push({ ref, signal });
            return new Promise(() => {});
          },
        },
      },
      s.actions,
    );
    s.lazy.setActive(false);
  });
  await page.waitForTimeout(100);
  expect(
    await page.evaluate(() => (window as any).cardsFixture.lazyCalls.length),
  ).toBe(0);
  await page.locator("[data-card-id=lazy]").scrollIntoViewIfNeeded();
  expect(
    await page.evaluate(() => (window as any).cardsFixture.lazyCalls.length),
  ).toBe(0);
  await page.evaluate(() => (window as any).cardsFixture.lazy.setActive(true));
  await expect
    .poll(() =>
      page.evaluate(() => (window as any).cardsFixture.lazyCalls.length),
    )
    .toBe(2);
  await page.evaluate(() => (window as any).cardsFixture.lazy.destroy());
  expect(
    await page.evaluate(() =>
      (window as any).cardsFixture.lazyCalls.every(
        (call: any) => call.signal.aborted,
      ),
    ),
  ).toBe(true);
  await page.evaluate(() => {
    const s = (window as any).cardsFixture;
    s.cards[1].setSpec({
      ...s.specs[1],
      source: {
        mode: "explicit",
        series: [{ kind: "metric", runId: "missing", key: "missing" }],
      },
    });
  });
  await card(page, 1).scrollIntoViewIfNeeded();
  await expect(card(page, 1).locator(".card-notice")).toHaveText(
    "1 series unavailable",
  );
  await expect(card(page, 1).getByRole("status")).toContainText(
    "No matching series",
  );
});
