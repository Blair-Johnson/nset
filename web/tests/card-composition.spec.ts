import { test, expect, type Page, type TestInfo } from "@playwright/test";
import { writeFile } from "node:fs/promises";

function threeRuns(catalog: any) {
  catalog.runs = ["run", "run2", "run3"].map((id, i) => ({
    ...catalog.runs[0],
    id,
    name: `Training ${i + 1}`,
  }));
  catalog.series = catalog.runs.map((run: any) => ({
    ...catalog.series[0],
    run_id: run.id,
  }));
  return catalog;
}

const target = '[data-card-id="resize-13"]';

async function fixture(page: Page, bottom = false) {
  let histories = 0;
  await page.setViewportSize({ width: 1800, height: 1000 });
  await page.route("**/api/**", (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === "/api/views") return route.fulfill({ json: { views: [] } });
    if (path === "/api/catalog")
      return route.fulfill({
        json: threeRuns({
          experiments: [
            { id: "resize", name: "Resize dashboard", created_at: 0 },
          ],
          runs: [
            {
              id: "run",
              experiment_id: "resize",
              name: "Training",
              status: "finished",
              params: {},
              tags: {},
              created_at: 0,
              updated_at: 0,
            },
          ],
          series: [
            {
              run_id: "run",
              key: "train/learning_rate",
              kind: "metric",
              count: 101,
              last_step: 100,
              last_timestamp: 100,
              last_value: 100,
            },
          ],
        }),
      });
    if (path.endsWith("/metrics")) {
      histories++;
      return route.fulfill({
        json: {
          points: Array.from({ length: 101 }, (_, step) => ({
            seq: step + 1,
            step: step + 1,
            timestamp: step,
            value: step === 0 ? 0 : 0.001 / (1 + step),
          })),
          total: 101,
          snapshot: 101,
          next_after: null,
        },
      });
    }
    return route.fulfill({ status: 404, json: { error: "Not found" } });
  });
  await page.goto("/");
  await page.evaluate(async (bottom) => {
    const { newChart, saveLibrary } = await import("/src/workspace.ts");
    const cards = Array.from({ length: bottom ? 14 : 24 }, (_, i) => ({
      ...newChart("timeseries", ["train/learning_rate"], `Learning rate ${i}`),
      id: `resize-${i}`,
      layout: { width: 580, height: 420 },
    }));
    for (const card of cards) {
      card.config.xScale = "log";
      card.config.yScale = "log";
    }
    saveLibrary({
      version: 2,
      activeByExperiment: { resize: "long-view" },
      views: [
        {
          version: 2,
          id: "long-view",
          experimentId: "resize",
          name: "Long view",
          selectedRunIds: ["run", "run2", "run3"],
          updatedAt: 0,
          sections: [
            {
              id: "first",
              title: "Training",
              collapsed: false,
              cards: cards.slice(0, 18),
            },
            {
              id: "second",
              title: "More charts",
              collapsed: false,
              cards: cards.slice(18),
            },
          ],
        },
      ],
    });
  }, bottom);
  await page.reload();
  await page.evaluate(async () => {
    const { ChartCard } = await import("/src/cards.ts");
    const state = ((window as any).resizeTest = { cards: {} });
    const proto = ChartCard.prototype as any;
    const buildShell = proto.buildShell;
    proto.buildShell = function (...args: any[]) {
      const result = buildShell.apply(this, args);
      state.cards[this.spec.id] = this;
      return result;
    };
    const ensurePanel = proto.ensurePanel;
    const instrumentedPlots = new WeakSet();
    proto.ensurePanel = function (...args: any[]) {
      const result = ensurePanel.apply(this, args);
      if (this.plot && !instrumentedPlots.has(this.plot)) {
        instrumentedPlots.add(this.plot);
        const publish = this.plot.onWarnings;
        this.plot.onWarnings = (warnings: string[]) => {
          (state.warnings ??= {})[this.spec.id] = warnings;
          publish(warnings);
        };
      }
      return result;
    };
  });
  await page.getByLabel("Access token", { exact: true }).fill("fixture");
  await page.getByRole("button", { name: "Connect", exact: true }).click();
  await page
    .getByRole("button", { name: "Resize dashboard", exact: true })
    .click();
  await page.getByRole("button", { name: "View charts", exact: true }).click();
  await page.locator(`${target} .card-resize-handle`).scrollIntoViewIfNeeded();
  await expect(page.locator(`${target} canvas`)).toBeVisible();
  await page.evaluate(() => {
    const s = (window as any).resizeTest;
    const c = s.cards["resize-13"];
    c.setPin("a", 30);
    c.setPin("yB", 0.00002);
    c.plot.zoom(1.5);
    s.canvas = c.host.querySelector("canvas");
    s.plot = c.plot.chart;
    s.data = c.data;
    s.navigation = c.plot.navigation;
    s.viewport = c.plot.viewport();
    s.pins = { ...c.pins };
  });
  const dashboard = page.locator("#dashboard");
  if (bottom)
    await dashboard.evaluate((node) => node.scrollTo(0, node.scrollHeight));
  await frames(page, 4);
  expect(await dashboard.evaluate((node) => node.scrollTop)).toBeGreaterThan(
    1000,
  );
  expect(await page.evaluate(() => window.scrollY)).toBe(0);
  return () => histories;
}

async function frames(page: Page, count = 3) {
  await page.evaluate(async (n) => {
    for (let i = 0; i < n; i++) await new Promise(requestAnimationFrame);
  }, count);
}

async function geometry(page: Page) {
  await frames(page, 4);
  const measurement = await page.evaluate(() => {
    const s = (window as any).resizeTest,
      c = s.cards["resize-13"];
    const rect = (el: Element) => {
      const r = el.getBoundingClientRect();
      return { x: r.x, y: r.y, width: r.width, height: r.height };
    };
    return {
      card: rect(c.root),
      plot: rect(c.plot.chart.over),
      canvas: rect(c.plot.chart.root),
      header: rect(c.root.querySelector(".card-header")),
      components: Object.fromEntries(
        [
          ".card-content",
          ".card-legend-details",
          ".card-legend",
          ".card-inspection",
          ".card-status",
          ".card-clipping",
        ].map((sel) => [
          sel,
          {
            ...rect(c.root.querySelector(sel)),
            text: c.root.querySelector(sel).textContent,
          },
        ]),
      ),
      foldHeight: c.root.style.getPropertyValue("--card-fold-height"),
      layout: c.spec.layout,
      viewport: c.plot.viewport(),
      pins: c.pins,
      sameCanvas: s.canvas === c.host.querySelector("canvas"),
      samePlot: s.plot === c.plot.chart,
      sameNavigation: s.navigation === c.plot.navigation,
      sameData: s.data === c.data,
      scroll: document.getElementById("dashboard")!.scrollTop,
      windowScroll: window.scrollY,
    };
  });
  expect(measurement.windowScroll).toBe(0);
  return measurement;
}

async function capture(page: Page, info: TestInfo, name: string) {
  const measurement = await geometry(page);
  await writeFile(
    info.outputPath(`${name}.json`),
    JSON.stringify(measurement, null, 2),
  );
  await page.screenshot({ path: info.outputPath(`${name}.png`) });
  // Decode retained screenshot pixels rather than treating a successful PNG write as visual evidence.
  const png = await page
    .locator(`${target} .u-over`)
    .screenshot({ path: info.outputPath(`${name}-plot.png`) });
  const pixels = await page.evaluate(
    async (dataURL) => {
      const image = new Image();
      image.src = dataURL;
      await image.decode();
      const canvas = document.createElement("canvas");
      canvas.width = image.width;
      canvas.height = image.height;
      const ctx = canvas.getContext("2d")!;
      ctx.drawImage(image, 0, 0);
      const bytes = ctx.getImageData(0, 0, image.width, image.height).data;
      let colored = 0;
      for (let i = 0; i < bytes.length; i += 4)
        if (
          Math.max(bytes[i], bytes[i + 1], bytes[i + 2]) -
            Math.min(bytes[i], bytes[i + 1], bytes[i + 2]) >
          50
        )
          colored++;
      return { width: image.width, height: image.height, colored };
    },
    `data:image/png;base64,${png.toString("base64")}`,
  );
  expect(pixels.colored).toBeGreaterThan(30);
  console.log(
    JSON.stringify({ kind: "card-composition", name, ...measurement, pixels }),
  );
  return measurement;
}

for (const direction of ["grow", "shrink"] as const)
  test(`wrapped below-fold ${direction} keeps the slot and every sibling fixed until release`, async ({
    page,
  }, info) => {
    await fixture(page);
    await page.evaluate((direction) => {
      const s = (window as any).resizeTest,
        c = s.cards["resize-13"];
      const width = c.host.parentElement.clientWidth;
      const half = Math.floor((width - 12) / 2);
      for (const card of Object.values(s.cards) as any[])
        card.actions.onDimensions(card.spec.id, { width: half, height: 420 });
      if (direction === "shrink")
        c.actions.onDimensions(c.spec.id, { width: half + 180, height: 420 });
      s.half = half;
    }, direction);
    await page
      .locator(`${target} .card-resize-handle`)
      .evaluate((node) => node.scrollIntoView({ block: "center" }));
    await frames(page);
    const before = await geometry(page);
    const handle = page.locator(`${target} .card-resize-handle`),
      r = (await handle.boundingBox())!;
    await page.evaluate(() => {
      const s = (window as any).resizeTest,
        c = s.cards["resize-13"];
      s.recording = true;
      s.phase = "preview";
      c.resizeHandle.addEventListener(
        "pointerup",
        () => {
          s.phase = "committed";
        },
        { once: true },
      );
      s.samples = [];
      s.saved = localStorage.getItem("nset.workspaces.v2");
      const sample = () => {
        s.samples.push({
          phase: s.phase,
          size: {
            width: c.root.getBoundingClientRect().width,
            height: c.root.getBoundingClientRect().height,
          },
          canvas: { width: c.plot.chart.width, height: c.plot.chart.height },
          target: {
            x: c.root.getBoundingClientRect().x,
            y: c.root.getBoundingClientRect().y,
          },
          siblings: Array.from(
            document.querySelectorAll<HTMLElement>(".dashboard-cell"),
          ).map((el) => {
            const r = el.getBoundingClientRect();
            return [el.dataset.cardId, r.x, r.y, r.width, r.height];
          }),
          layout: { ...c.spec.layout },
          scroll: document.getElementById("dashboard")!.scrollTop,
          windowScroll: window.scrollY,
        });
        if (s.recording) requestAnimationFrame(sample);
      };
      sample();
    });
    await page.mouse.move(r.x + 10, r.y + 10);
    await page.mouse.down();
    await page.mouse.move(
      r.x + 10 + (direction === "grow" ? 180 : -180),
      r.y + 50,
      { steps: 12 },
    );
    await frames(page, 6);
    const preview = await geometry(page);
    const evidence = await page.evaluate(() => {
      const s = (window as any).resizeTest;
      return {
        frames: s.samples,
        captured: s.cards["resize-13"].resizeHandle.hasPointerCapture(1),
        savedPresent: !!s.saved,
        unchangedStorage:
          s.saved === localStorage.getItem("nset.workspaces.v2"),
      };
    });
    await writeFile(
      info.outputPath(`${direction}-before-release-frames.json`),
      JSON.stringify(evidence, null, 2),
    );
    expect(evidence.frames.length).toBeGreaterThan(6);
    expect(evidence.captured).toBe(true);
    expect(evidence.savedPresent).toBe(true);
    expect(evidence.unchangedStorage).toBe(true);
    for (const frame of evidence.frames) {
      expect(frame.target).toEqual(evidence.frames[0].target);
      expect(frame.siblings).toEqual(evidence.frames[0].siblings);
      expect(frame.layout).toEqual(before.layout);
      expect(frame.scroll).toBe(before.scroll);
      expect(frame.windowScroll).toBe(0);
    }
    expect(preview.card.width - before.card.width).toBe(
      direction === "grow" ? 180 : -180,
    );
    expect(preview.plot.height - before.plot.height).toBe(40);
    await page.screenshot({
      path: info.outputPath(`${direction}-preview.png`),
    });
    await page.mouse.up();
    const after = await geometry(page);
    await frames(page, 6);
    const committedFrames = await page.evaluate(() => {
      const s = (window as any).resizeTest;
      s.recording = false;
      return s.samples.filter((frame: any) => frame.phase === "committed");
    });
    await writeFile(
      info.outputPath(`${direction}-after-release-frames.json`),
      JSON.stringify(committedFrames, null, 2),
    );
    expect(committedFrames.length).toBeGreaterThan(5);
    for (const frame of committedFrames) {
      expect(frame.layout).toEqual(after.layout);
      expect(frame.target).toEqual({ x: after.card.x, y: after.card.y });
      expect(frame.siblings).toEqual(committedFrames[0].siblings);
      expect(frame.windowScroll).toBe(0);
    }
    expect(after.layout.width).toBe(
      before.layout.width + (direction === "grow" ? 180 : -180),
    );
    expect(after.layout.height).toBe(before.layout.height + 40);
    expect(after.card.x).not.toBe(before.card.x);
    expect(after.viewport).toEqual(before.viewport);
    expect(after.pins).toEqual(before.pins);
    expect(
      after.sameCanvas &&
        after.samePlot &&
        after.sameData &&
        after.sameNavigation,
    ).toBe(true);
    expect(await page.locator(".card-resizing-slot").count()).toBe(0);
    // Element screenshots may scroll a wrapped card into view; record them only
    // after the frame-stability assertions have finished.
    await capture(page, info, `${direction}-committed`);
  });

test("log/log three-run folds preserve the canvas and resize persists only base height", async ({
  page,
}, info) => {
  await fixture(page);
  const card = page.locator(target);
  const normal = await capture(page, info, "normal");
  await card.getByText("Show legend", { exact: true }).click();
  const legend = await geometry(page);
  expect(legend.plot).toEqual(normal.plot);
  expect(legend.card.height).toBeGreaterThan(normal.card.height);
  expect(await card.locator(".card-legend-key").count()).toBe(0);
  await card.getByRole("button", { name: "Add horizontal cursor" }).click();
  const inspector = await geometry(page);
  expect(inspector.plot).toEqual(normal.plot);
  await page.evaluate(() => {
    const c = (window as any).resizeTest.cards["resize-13"];
    c.setPin("yA", 0.00005);
    c.setPin("yB", 0.00002);
  });
  const positions = await geometry(page);
  expect(positions.plot).toEqual(normal.plot);
  await expect(card.locator(".card-coordinate").first()).toBeHidden();
  await card.getByText("Per-run values / crossings", { exact: true }).click();
  const details = await geometry(page);
  expect(details.plot).toEqual(normal.plot);
  await card.getByText("Edit positions", { exact: true }).click();
  await expect(
    card.locator(".card-position-readout output:visible"),
  ).toHaveCount(1);
  const editor = await geometry(page);
  expect(editor.plot).toEqual(normal.plot);
  await card.locator(".card-crossings summary").first().click();
  const crossing = await capture(page, info, "open-folds");
  expect(crossing.plot).toEqual(normal.plot);
  expect(crossing.viewport).toEqual(normal.viewport);
  const h = card.locator(".card-resize-handle");
  // Keep this pure size check away from the panel's auto-scroll edge.
  await h.evaluate((node) => node.scrollIntoView({ block: "center" }));
  await frames(page);
  const box = (await h.boundingBox())!;
  await page.mouse.move(box.x + 10, box.y + 10);
  await page.mouse.down();
  await page.mouse.move(box.x + 90, box.y + 70, { steps: 8 });
  await page.mouse.up();
  const resized = await capture(page, info, "resized-folds");
  expect(resized.layout.height).toBe(normal.layout.height + 60);
  expect(resized.plot.height).toBe(normal.plot.height + 60);
  expect(resized.viewport).toEqual(normal.viewport);
  await card.getByRole("button", { name: "Clear cursors" }).click();
  const cleared = await geometry(page);
  expect(cleared.pins).toEqual({
    a: null,
    b: null,
    threshold: null,
    yA: null,
    yB: null,
  });
  expect(cleared.viewport).toEqual(resized.viewport);
  await card.getByText("Show legend", { exact: true }).click();
  const closed = await geometry(page);
  expect(closed.card.height).toBe(normal.layout.height + 60);
  expect(closed.plot.height).toBe(normal.plot.height + 60);
  await page.evaluate(() => {
    const c = (window as any).resizeTest.cards["resize-13"];
    c.actions.onDimensions(c.spec.id, { width: 1100, height: 1170 });
  });
  const wide = await capture(page, info, "wide-1170");
  expect(wide.plot.height).toBeGreaterThan(950);
  await card
    .getByRole("button", { name: "Maximize chart", exact: true })
    .click();
  const full = await capture(page, info, "maximized");
  expect(full.plot.height).toBeGreaterThan(750);
  await card.getByText("Show legend", { exact: true }).click();
  await card.getByRole("button", { name: "Add horizontal cursor" }).click();
  const fullOpen = await capture(page, info, "maximized-folds");
  expect(fullOpen.plot).toEqual(full.plot);
  await page.keyboard.press("Escape");
  const restored = await geometry(page);
  expect(restored.layout).toEqual(wide.layout);
});

test("Fit configured range preserves sources, configuration, card geometry, pins and neighbors; warnings never become native plot titles", async ({
  page,
}, info) => {
  await fixture(page);
  const card = page.locator(target);
  const warnings = await page.evaluate(
    () => (window as any).resizeTest.warnings["resize-13"],
  );
  expect(
    warnings.some((text: string) => text.includes("excluded from log display")),
  ).toBe(true);
  // Real log warnings must not become a native plot title.
  await expect(card.locator(".card-plot")).not.toHaveAttribute("title");
  await card.locator(".u-over").hover();
  await page.waitForTimeout(800);
  await expect(card.locator(".card-plot")).not.toHaveAttribute("title");
  const before = await geometry(page);
  const source = await page.evaluate(() => {
    const c = (window as any).resizeTest.cards["resize-13"];
    return JSON.stringify(c.spec);
  });
  await card
    .getByRole("button", { name: "Fit configured range", exact: true })
    .click();
  const after = await capture(page, info, "reset-view");
  expect(after.card).toEqual(before.card);
  expect(after.pins).toEqual(before.pins);
  expect(after.sameCanvas && after.sameData && after.samePlot).toBe(true);
  expect(after.viewport).not.toEqual(before.viewport);
  expect(
    await page.evaluate(() =>
      JSON.stringify((window as any).resizeTest.cards["resize-13"].spec),
    ),
  ).toBe(source);
  await expect(card.locator(".card-plot")).not.toHaveAttribute("title");
});

test("image card Fit fits the existing frame without clearing sources or cache", async ({
  page,
}, info) => {
  await page.route(/^http:\/\/127\.0\.0\.1:[0-9]+\/$/, (route) =>
    route.fulfill({
      contentType: "text/html",
      body: "<!doctype html><body></body>",
    }),
  );
  await page.goto("/");
  await page.evaluate(async () => {
    const { ChartCard } = await import("/src/cards.ts");
    const { newChart } = await import("/src/workspace.ts");
    const { Api } = await import("/src/api.ts");
    document.body.style.cssText =
      "margin:20px;display:flex;gap:20px;align-items:flex-start;--surface:#202429;--text:#ddd;--border:#555";
    const canvas = document.createElement("canvas");
    canvas.width = 256;
    canvas.height = 128;
    const ctx = canvas.getContext("2d")!;
    ctx.fillStyle = "#0aaaff";
    ctx.fillRect(0, 0, 256, 128);
    const bytes: Blob = await new Promise((resolve) =>
      canvas.toBlob((b) => resolve(b!), "image/png"),
    );
    const s: any = { cards: [], requests: 0 };
    const api = new Api(
      () => "secret",
      async (url: string) => {
        s.requests++;
        if (url.endsWith("/images"))
          return Response.json({
            images: [0, 1].map((step) => ({
              id: `f${step}`,
              run_id: "run",
              key: "image",
              step,
              timestamp: step,
              content_type: "image/png",
              byte_length: bytes.size,
            })),
          });
        return new Response(bytes, {
          headers: { "Content-Type": "image/png" },
        });
      },
    );
    const run = {
      id: "run",
      name: "Training",
      experiment_id: "e",
      status: "finished",
      params: {},
      tags: {},
      created_at: 0,
      updated_at: 0,
    };
    const context = {
      api,
      selectedRunIds: ["run"],
      store: {},
      catalog: {
        experiments: [],
        runs: [run],
        series: [
          {
            run_id: "run",
            key: "image",
            kind: "image",
            count: 2,
            last_step: 1,
            last_timestamp: 1,
            last_value: null,
          },
        ],
      },
    };
    for (let i = 0; i < 2; i++) {
      const host = document.createElement("div");
      host.style.cssText = "width:600px;flex:none";
      document.body.append(host);
      const spec = newChart("image", ["image"], `Image ${i}`);
      spec.layout = { width: 600, height: 480 };
      s.cards.push(
        new ChartCard(host, spec, context as any, {
          onEdit() {},
          onRemove() {},
          onMove() {},
          onDuplicate() {},
          onResize() {},
        }),
      );
    }
    (window as any).imageReset = s;
  });
  const card = page.locator(".chart-card").first();
  await expect(card.locator(".frame-info")).toContainText("Step 0");
  await card.getByRole("button", { name: "Next", exact: false }).click();
  await expect(card.locator(".frame-info")).toContainText("Step 1");
  await page.evaluate(() => {
    const s = (window as any).imageReset,
      c = s.cards[0],
      p = c.images;
    p.viewer.viewport.zoomTo(
      p.viewer.viewport.getHomeZoom() * 2,
      undefined,
      true,
    );
    s.before = {
      spec: JSON.stringify(c.spec),
      frame: p.displayed,
      cache: p.cache,
      frames: p.frames,
      viewer: p.viewer,
      item: p.viewer.world.getItemAt(0),
      requests: s.requests,
      rects: s.cards.map((c: any) =>
        JSON.stringify(c.root.getBoundingClientRect()),
      ),
    };
  });
  await card.getByRole("button", { name: "Fit", exact: true }).click();
  await expect
    .poll(() =>
      page.evaluate(() => {
        const p = (window as any).imageReset.cards[0].images;
        return Math.abs(
          p.viewer.viewport.getZoom(true) - p.viewer.viewport.getHomeZoom(),
        );
      }),
    )
    .toBeLessThan(0.0001);
  const after = await page.evaluate(() => {
    const s = (window as any).imageReset,
      c = s.cards[0],
      p = c.images,
      b = s.before;
    return {
      spec: JSON.stringify(c.spec) === b.spec,
      frame: p.displayed === b.frame,
      cache: p.cache === b.cache && p.cache.size > 0,
      frames: p.frames === b.frames,
      viewer: p.viewer === b.viewer,
      item: p.viewer.world.getItemAt(0) === b.item,
      requests: s.requests === b.requests,
      rects: s.cards.every(
        (c: any, i: number) =>
          JSON.stringify(c.root.getBoundingClientRect()) === b.rects[i],
      ),
    };
  });
  expect(Object.values(after).every(Boolean), JSON.stringify(after)).toBe(true);
  await page.screenshot({ path: info.outputPath("image-reset-view.png") });
});

test("first cursor results and live pin dragging never resize the canvas or cancel capture", async ({
  page,
}, info) => {
  await fixture(page);
  const card = page.locator(target);
  await page.evaluate(() => {
    const c = (window as any).resizeTest.cards["resize-13"];
    c.pins = { a: null, b: null, threshold: null, yA: null, yB: null };
    c.plot.setPins(c.pins);
  });
  const before = await geometry(page);
  await card.getByText("Show legend", { exact: true }).click();
  await card.getByRole("button", { name: "Add horizontal cursor" }).click();
  const point = await page.evaluate(() => {
    const c = (window as any).resizeTest.cards["resize-13"],
      u = c.plot.chart,
      r = u.over.getBoundingClientRect();
    return { x: r.x + r.width * 0.45, y: r.y + u.valToPos(0.00005, "y") };
  });
  await page.mouse.click(point.x, point.y);
  expect((await geometry(page)).plot).toEqual(before.plot);
  expect(
    await page.evaluate(
      () => (window as any).resizeTest.cards["resize-13"].activePin,
    ),
  ).toBe("b");
  await card.getByText("Per-run values / crossings", { exact: true }).click();
  await page.mouse.move(point.x, point.y);
  await page.mouse.down();
  await page.mouse.move(point.x, point.y - 35, { steps: 8 });
  await frames(page, 6);
  const live = await page.evaluate(() => {
    const c = (window as any).resizeTest.cards["resize-13"];
    return {
      active: !!c.plot.navigation.gesture,
      captured: c.plot.chart.over.hasPointerCapture(1),
      pin: c.pins.yA,
      pending: c.activePin,
    };
  });
  expect(live.active && live.captured).toBe(true);
  expect(live.pin).not.toBe(0.00005);
  expect(live.pending).toBe("b");
  expect((await geometry(page)).plot).toEqual(before.plot);
  await page.screenshot({
    path: info.outputPath("live-pin-drag-open-results.png"),
  });
  await page.mouse.up();
  expect((await geometry(page)).viewport).toEqual(before.viewport);
});

test("maximized folds retain both canvas dimensions under the browser scrollbar policy", async ({
  page,
}, info) => {
  await fixture(page);
  await page.addStyleTag({
    content: ".card-content::-webkit-scrollbar { width: 16px; height: 16px; }",
  });
  const card = page.locator(target);
  await card
    .getByRole("button", { name: "Maximize chart", exact: true })
    .click();
  const before = await geometry(page);
  const gutter = await card.locator(".card-content").evaluate((node) => {
    const probe = document.createElement("div");
    probe.className = "card-content";
    probe.style.cssText =
      "position:fixed;left:-1000px;width:100px;height:100px;padding:0;border:0;overflow:scroll;scrollbar-gutter:stable;";
    document.body.append(probe);
    const nativeWidth = probe.getBoundingClientRect().width - probe.clientWidth;
    probe.remove();
    return {
      policy: getComputedStyle(node).scrollbarGutter,
      width: node.getBoundingClientRect().width - node.clientWidth,
      nativeWidth,
    };
  });
  expect(gutter.policy).toBe("stable");
  expect(gutter.width).toBe(gutter.nativeWidth);
  console.log(JSON.stringify({ kind: "fullscreen-scrollbar", ...gutter }));
  for (let i = 0; i < 3; i++) {
    await card.getByText("Show legend", { exact: true }).click();
    await card
      .getByRole("button", { name: "Add vertical cursor", exact: true })
      .click();
    const open = await geometry(page);
    expect(open.plot.width).toBe(before.plot.width);
    expect(open.plot.height).toBe(before.plot.height);
    expect(open.viewport).toEqual(before.viewport);
    if (
      !(await card
        .locator(".card-position-editor")
        .evaluate((node) => (node as HTMLDetailsElement).open))
    ) {
      await card.getByText("Edit positions", { exact: true }).click();
    }
    await card
      .getByRole("button", { name: "Place vertical cursor A", exact: true })
      .click();
    await expect(card.locator(".card-position-editor")).toHaveAttribute(
      "open",
      "",
    );
    await card
      .getByRole("button", { name: "Clear cursors", exact: true })
      .click();
    await card.getByText("Show legend", { exact: true }).click();
    const closed = await geometry(page);
    expect(closed.plot.width).toBe(before.plot.width);
    expect(closed.plot.height).toBe(before.plot.height);
  }
  await capture(page, info, "fullscreen-stable-scrollbar");
});
