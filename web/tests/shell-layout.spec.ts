import { writeFile } from "node:fs/promises";
import { test, expect, type Page } from "@playwright/test";

const runs = Array.from({ length: 60 }, (_, index) => ({
  id: `run-${index}`,
  experiment_id: "dense",
  name: `Run ${String(index).padStart(2, "0")} ${index === 42 ? "long namespace / ".repeat(16) : "training"}`,
  status: index % 2 ? "running" : "finished",
  params: { seed: index, group: index < 30 ? "first" : "second" },
  tags: { owner: "fixture" },
  created_at: 1700000000000 + index,
  updated_at: 1700000000000 + index,
}));
async function fixture(page: Page) {
  let histories = 0;
  await page.route("**/api/**", async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname === "/api/catalog")
      return route.fulfill({
        json: {
          experiments: [
            { id: "dense", name: "Dense workspace", created_at: 1700000000000 },
          ],
          runs,
          series: runs.map((run) => ({
            run_id: run.id,
            key: "train/loss",
            kind: "metric",
            count: 3,
            last_step: 2,
            last_timestamp: run.created_at,
            last_value: 1,
          })),
        },
      });
    if (url.pathname.endsWith("/metrics")) {
      histories++;
      return route.fulfill({
        json: {
          points: [0, 1, 2].map((step) => ({
            seq: step + 1,
            step,
            timestamp: 1700000000000 + step,
            value: 3 - step,
          })),
          total: 3,
          snapshot: 3,
          next_after: null,
        },
      });
    }
    return route.fulfill({ status: 404, json: { error: "Not found" } });
  });
  await page.goto("/");
  await page.getByLabel("Access token", { exact: true }).fill("fixture");
  await page.getByRole("button", { name: "Connect", exact: true }).click();
  await page
    .getByRole("button", { name: "Dense workspace", exact: true })
    .click();
  return () => histories;
}
async function charts(page: Page) {
  await page
    .locator(".run-table")
    .getByRole("button", { name: "Run", exact: true })
    .click();
  await page
    .getByRole("checkbox", { name: `Select ${runs[0].name}`, exact: true })
    .check();
  await page.getByRole("button", { name: "View charts", exact: true }).click();
  await page.locator(".dashboard-cell canvas").first().waitFor();
}

test("dense tables have no selection tint, preserve hover/focus, and route to details", async ({
  page,
}, info) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  await fixture(page);
  const row = page.locator('tr[data-run-id="run-59"]');
  const other = page.locator('tr[data-run-id="run-58"]');
  const check = row.getByRole("checkbox");
  await check.check();
  await page.mouse.move(0, 0);
  expect(
    await row.evaluate((node) => getComputedStyle(node).backgroundColor),
  ).toBe(
    await other.evaluate((node) => getComputedStyle(node).backgroundColor),
  );
  expect(
    await row.evaluate((node) => getComputedStyle(node).outlineStyle),
  ).not.toBe("none");
  await other.hover();
  expect(
    await other.evaluate((node) => getComputedStyle(node).backgroundColor),
  ).not.toBe(
    await row.evaluate((node) => getComputedStyle(node).backgroundColor),
  );
  expect((await row.boundingBox())!.height).toBeLessThanOrEqual(34);
  expect(
    (await page.locator(".app-header").boundingBox())!.height,
  ).toBeLessThanOrEqual(40);
  expect((await row.boundingBox())!.y).toBeLessThanOrEqual(160);
  await expect(page.locator(".row-subtitle")).toHaveCount(0);
  await expect(page.locator(".run-table [data-run-color-id]")).toHaveCount(50);
  await page.screenshot({
    path: info.outputPath("dense-table-desktop.png"),
    fullPage: true,
  });
  await row.getByRole("button", { name: runs[59].name, exact: true }).click();
  await expect(page).toHaveURL(/#\/experiments\/dense\/runs\/run-59$/);
  await expect(page.locator(".run-detail")).toBeVisible();
  await expect(page.locator(".run-details-dialog")).toHaveCount(0);
});

test("60-run drawer retains checkbox identity, focus, filter, scroll and open state", async ({
  page,
}, info) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  await fixture(page);
  await charts(page);
  const drawer = page.locator(".run-drawer");
  await expect(drawer).toBeVisible();
  await expect(drawer.locator(".run-drawer-row")).toHaveCount(60);
  expect(
    (await page.locator(".section-heading").first().boundingBox())!.y,
  ).toBeLessThanOrEqual(140);
  expect(
    (await page.locator(".workspace-toolbar").boundingBox())!.height,
  ).toBeLessThanOrEqual(40);
  const choice = drawer.getByRole("checkbox", {
    name: `Show ${runs[42].name}`,
    exact: true,
  });
  await choice.scrollIntoViewIfNeeded();
  await choice.focus();
  const handle = await choice.elementHandle();
  const scroll = await drawer
    .locator(".run-drawer-list")
    .evaluate((node) => node.scrollTop);
  await choice.press("Space");
  await expect(choice).toBeChecked();
  await expect(choice).toBeFocused();
  expect(await choice.evaluate((node, old) => node === old, handle)).toBe(true);
  expect(
    await drawer.locator(".run-drawer-list").evaluate((node) => node.scrollTop),
  ).toBe(scroll);
  await expect(page.getByLabel("Collapse run list")).toHaveAttribute(
    "aria-expanded",
    "true",
  );
  await drawer.getByLabel("Find runs", { exact: true }).fill("second");
  await drawer
    .getByRole("button", { name: "Select matching", exact: true })
    .click();
  await expect(drawer.locator(".drawer-selection-count")).toHaveText(
    "31 selected",
  );
  await expect(drawer.locator(".run-drawer-row:visible")).toHaveCount(30);
  const filter = await drawer
    .getByLabel("Find runs", { exact: true })
    .inputValue();
  await page.getByLabel("Collapse run list").click();
  await expect(drawer).toBeHidden();
  await page.getByLabel("Expand run list").click();
  await expect(drawer.getByLabel("Find runs", { exact: true })).toHaveValue(
    filter,
  );
  await page.screenshot({
    path: info.outputPath("dense-drawer-desktop.png"),
    fullPage: true,
  });
});

test("run detail and table navigation retain dashboard canvas, zoom and drawer state", async ({
  page,
}) => {
  const histories = await fixture(page);
  await charts(page);
  const canvas = await page
    .locator(".dashboard-cell canvas")
    .first()
    .elementHandle();
  await page
    .getByRole("button", { name: "Zoom in", exact: true })
    .first()
    .click();
  await page
    .getByRole("separator", { name: "Resize run list", exact: true })
    .press("End");
  await page.getByLabel("Find runs", { exact: true }).fill("Run 00");
  const before = histories();
  await page
    .locator(".run-drawer")
    .getByRole("button", { name: runs[0].name, exact: true })
    .click();
  await expect(page).toHaveURL(/runs\/run-0$/);
  await page
    .getByRole("navigation", { name: "Experiment views" })
    .getByRole("button", { name: "Charts", exact: true })
    .click();
  expect(
    await page
      .locator(".dashboard-cell canvas")
      .first()
      .evaluate((node, old) => node === old, canvas),
  ).toBe(true);
  await expect(
    page.getByRole("button", { name: "Previous view", exact: true }).first(),
  ).toBeEnabled();
  await expect(page.getByLabel("Find runs", { exact: true })).toHaveValue(
    "Run 00",
  );
  expect(histories()).toBe(before);
  expect((await page.locator(".run-drawer").boundingBox())!.width).toBe(600);
});

test("color events refresh existing cards without reloading histories or losing zoom", async ({
  page,
}) => {
  const histories = await fixture(page);
  await charts(page);
  await page
    .getByRole("button", { name: "Zoom in", exact: true })
    .first()
    .click();
  const canvas = await page
    .locator(".dashboard-cell canvas")
    .first()
    .elementHandle();
  const before = histories();
  await page.evaluate(async () => {
    const { setRunColor } = await import("/src/series-colors.ts");
    if (!setRunColor("run-0", "#ff00aa"))
      throw new Error("Could not persist color");
  });
  expect(
    await page
      .locator(".dashboard-cell canvas")
      .first()
      .evaluate((node, old) => node === old, canvas),
  ).toBe(true);
  await expect(
    page.getByRole("button", { name: "Previous view", exact: true }).first(),
  ).toBeEnabled();
  expect(histories()).toBe(before);
  const color = await page
    .locator('.run-drawer button[data-run-color-id="run-0"]')
    .evaluate((node) => getComputedStyle(node, "::before").backgroundColor);
  expect(color).toBe("rgb(255, 0, 170)");
});

test("390px drawer is an explicit overlay and leaves charts full width when closed", async ({
  page,
}, info) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await fixture(page);
  await charts(page);
  await expect(page.locator(".run-drawer")).toBeHidden();
  expect(
    (await page.locator(".dashboard").boundingBox())!.width,
  ).toBeGreaterThan(350);
  await page.getByLabel("Expand run list").click();
  await expect(page.getByRole("dialog", { name: "Chart runs" })).toBeVisible();
  await expect(page.getByLabel("Find runs", { exact: true })).toBeFocused();
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth),
  ).toBeLessThanOrEqual(390);
  await page.screenshot({
    path: info.outputPath("drawer-narrow-overlay.png"),
    fullPage: true,
  });
  await page.keyboard.press("Escape");
  await expect(page.locator(".run-drawer")).toBeHidden();
  await expect(page.getByLabel("Expand run list")).toBeFocused();
  await page.reload();
  await expect(page.locator(".run-drawer")).toBeHidden();
  const expand = page.getByRole("button", {
    name: "Expand run list",
    exact: true,
  });
  const box = (await expand.boundingBox())!;
  expect(box.x).toBeGreaterThanOrEqual(0);
  expect(box.y + box.height).toBeLessThan(844);
  await expand.click();
  await page
    .locator(".run-drawer-backdrop")
    .click({ position: { x: 380, y: 500 } });
  await expect(expand).toBeVisible();
  await expect(expand).toBeFocused();
  expect(
    (await page.locator(".dashboard").boundingBox())!.width,
  ).toBeGreaterThan(350);
  await page.screenshot({
    path: info.outputPath("drawer-narrow-collapsed.png"),
  });
});

test("selection persistence failure rolls back drawer checks without replacing focus", async ({
  page,
}) => {
  await fixture(page);
  await charts(page);
  await page.evaluate(() => {
    const original = Storage.prototype.setItem;
    Storage.prototype.setItem = function (key, value) {
      if (key === "nset.workspaces.v2") throw new Error("Storage full");
      original.call(this, key, value);
    };
  });
  const choice = page.getByRole("checkbox", {
    name: `Show ${runs[1].name}`,
    exact: true,
  });
  await choice.focus();
  const handle = await choice.elementHandle();
  await choice.press("Space");
  await expect(choice).not.toBeChecked();
  await expect(choice).toBeFocused();
  expect(await choice.evaluate((node, old) => node === old, handle)).toBe(true);
  await expect(page.locator("#global-error")).toContainText("Storage full");
  await expect(page.locator(".drawer-selection-count")).toHaveText(
    "1 selected",
  );
});

test("card dimension transactions persist both axes and roll back failed writes", async ({
  page,
}) => {
  await fixture(page);
  await charts(page);
  const card = page.locator(".dashboard-cell").first();
  const canvas = await card.locator("canvas").elementHandle();
  const handle = card.getByRole("button", {
    name: "Resize chart",
    exact: true,
  });
  await handle.focus();
  await handle.press("ArrowRight");
  await handle.press("ArrowDown");
  const saved = await page.evaluate(
    () =>
      JSON.parse(localStorage.getItem("nset.workspaces.v2")!).views[0]
        .sections[0].cards[0].layout,
  );
  expect(saved.width).toBeGreaterThanOrEqual(300);
  expect(saved.height).toBeGreaterThanOrEqual(240);
  expect(
    await card.locator("canvas").evaluate((node, old) => node === old, canvas),
  ).toBe(true);
  await page.reload();
  await card.locator("canvas").waitFor();
  expect(
    await card.evaluate((node) =>
      Number.parseFloat(
        getComputedStyle(node).getPropertyValue("--card-width"),
      ),
    ),
  ).toBe(saved.width);
  await page.evaluate(() => {
    const original = Storage.prototype.setItem;
    Storage.prototype.setItem = function (key, value) {
      if (key === "nset.workspaces.v2") throw new Error("Storage full");
      original.call(this, key, value);
    };
  });
  await handle.focus();
  await handle.press("ArrowRight");
  await expect(page.locator("#global-error")).toContainText("Storage full");
  expect(
    await page.evaluate(
      () =>
        JSON.parse(localStorage.getItem("nset.workspaces.v2")!).views[0]
          .sections[0].cards[0].layout,
    ),
  ).toEqual(saved);
  expect(
    await card.evaluate((node) =>
      Number.parseFloat(
        getComputedStyle(node).getPropertyValue("--card-width"),
      ),
    ),
  ).toBe(saved.width);
});

test("split-pane edge handle preserves 60-run plots and persists collapse and width", async ({
  page,
}, info) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  const histories = await fixture(page);
  await page.evaluate(async () => {
    const { PlotPanel } = await import("/src/plot.ts");
    const render = PlotPanel.prototype.render;
    PlotPanel.prototype.render = function (...args: Parameters<typeof render>) {
      (window as any).__drawerPlot = this;
      return render.apply(this, args);
    };
  });
  await charts(page);
  const drawer = page.locator(".run-drawer");
  await drawer
    .getByRole("button", { name: "Clear selection", exact: true })
    .click();
  await expect(drawer.locator(".drawer-selection-count")).toHaveText(
    "0 selected",
  );
  await page
    .getByRole("button", { name: "Collapse run list", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Expand run list", exact: true })
    .click();
  await expect(drawer.locator("input[type=checkbox]:checked")).toHaveCount(0);
  await drawer
    .getByRole("button", { name: "Select matching", exact: true })
    .click();
  await expect(drawer.locator("input[type=checkbox]:checked")).toHaveCount(60);
  await expect
    .poll(() =>
      page.evaluate(() => (window as any).__drawerPlot.chart?.series.length),
    )
    .toBeGreaterThanOrEqual(61);
  await expect.poll(histories).toBe(60);
  await page
    .getByRole("button", { name: "Zoom in", exact: true })
    .first()
    .click();
  const plot = await page.evaluateHandle(
    () => (window as any).__drawerPlot.chart,
  );
  const before = await page.evaluate(() => {
    const p = (window as any).__drawerPlot;
    p.setPins({ a: 0.5, b: 1.5 });
    return {
      min: p.chart.scales.x.min,
      max: p.chart.scales.x.max,
      pins: p.pins,
    };
  });
  const requests = histories();
  const separator = page.getByRole("separator", {
    name: "Resize run list",
    exact: true,
  });
  await separator.focus();
  await separator.press("Home");
  await expect(separator).toHaveAttribute("aria-valuenow", "250");
  await separator.press("End");
  await expect(separator).toHaveAttribute("aria-valuenow", "600");
  await separator.press("ArrowRight");
  await expect(separator).toHaveAttribute("aria-valuenow", "600");
  await separator.press("Shift+ArrowLeft");
  await expect(separator).toHaveAttribute("aria-valuenow", "550");
  const edge = (await separator.boundingBox())!;
  await page.mouse.move(edge.x + edge.width / 2, edge.y + 30);
  await page.mouse.down();
  await page.mouse.move(edge.x + edge.width / 2 - 150, edge.y + 30);
  await page.mouse.up();
  await expect(separator).toHaveAttribute("aria-valuenow", "400");
  const moved = (await separator.boundingBox())!;
  await page.mouse.move(moved.x + moved.width / 2, moved.y + 30);
  await page.mouse.down();
  await page.mouse.move(moved.x + moved.width / 2 + 50, moved.y + 30);
  await page.keyboard.press("Escape");
  await page.mouse.up();
  await expect(separator).toHaveAttribute("aria-valuenow", "400");
  await expect(drawer).toBeVisible();
  await page.mouse.move(moved.x + moved.width / 2, moved.y + 30);
  await page.mouse.down();
  await page.mouse.move(moved.x + moved.width / 2 + 80, moved.y + 30);
  await separator.dispatchEvent("pointercancel");
  await page.mouse.up();
  await expect(separator).toHaveAttribute("aria-valuenow", "400");
  await drawer.getByLabel("Find runs", { exact: true }).fill("second");
  const choice = drawer.getByRole("checkbox", {
    name: `Show ${runs[58].name}`,
    exact: true,
  });
  await choice.scrollIntoViewIfNeeded();
  await choice.focus();
  const row = await choice.elementHandle();
  const scroll = await drawer
    .locator(".run-drawer-list")
    .evaluate((node) => node.scrollTop);
  const geometry: Record<string, unknown> = {};
  const measure = () =>
    page.evaluate(() =>
      Object.fromEntries(
        [
          ".run-pane",
          ".run-pane-toggle",
          ".dashboard",
          ".workspace-layout",
        ].map((selector) => {
          const r = document.querySelector(selector)!.getBoundingClientRect();
          return [
            selector,
            { x: r.x, y: r.y, width: r.width, height: r.height },
          ];
        }),
      ),
    );
  geometry.expanded = await measure();
  await page.screenshot({
    path: info.outputPath("split-pane-60-runs-expanded.png"),
  });
  for (let i = 0; i < 3; i++) {
    await page
      .getByRole("button", { name: "Collapse run list", exact: true })
      .click();
    const expand = page.getByRole("button", {
      name: "Expand run list",
      exact: true,
    });
    await expect(expand).toBeVisible();
    const box = (await expand.boundingBox())!;
    expect(box.width).toBeGreaterThanOrEqual(32);
    expect(box.x).toBeGreaterThanOrEqual(0);
    expect(box.y + box.height).toBeLessThan(1000);
    expect((await page.locator(".run-pane").boundingBox())!.width).toBe(0);
    if (i === 0) {
      geometry.collapsed = await measure();
      await page.screenshot({
        path: info.outputPath("split-pane-60-runs-collapsed.png"),
      });
    }
    await expand.click();
    await expect(choice).toBeFocused();
    expect(await choice.evaluate((node, old) => node === old, row)).toBe(true);
    expect(
      await drawer
        .locator(".run-drawer-list")
        .evaluate((node) => node.scrollTop),
    ).toBe(scroll);
    await expect(drawer.getByLabel("Find runs", { exact: true })).toHaveValue(
      "second",
    );
    expect((await drawer.boundingBox())!.width).toBe(400);
  }
  expect(
    await page.evaluate(
      (old) => (window as any).__drawerPlot.chart === old,
      plot,
    ),
  ).toBe(true);
  expect(
    await page.evaluate(() => {
      const p = (window as any).__drawerPlot;
      return {
        min: p.chart.scales.x.min,
        max: p.chart.scales.x.max,
        pins: p.pins,
      };
    }),
  ).toEqual(before);
  expect(histories()).toBe(requests);
  await expect(
    page.getByRole("button", { name: "Previous view", exact: true }).first(),
  ).toBeEnabled();
  await page
    .getByRole("button", { name: "Collapse run list", exact: true })
    .click();
  await page.reload();
  await expect(drawer).toBeHidden();
  await page
    .getByRole("button", { name: "Expand run list", exact: true })
    .click();
  await expect(drawer.locator("input[type=checkbox]:checked")).toHaveCount(60);
  expect((await drawer.boundingBox())!.width).toBe(400);
  await page.reload();
  await expect(drawer).toBeVisible();
  expect((await drawer.boundingBox())!.width).toBe(400);
  const geometryPath = info.outputPath("split-pane-geometry.json");
  await writeFile(geometryPath, JSON.stringify(geometry, null, 2));
  await info.attach("split-pane-geometry.json", {
    path: geometryPath,
    contentType: "application/json",
  });
});

test("pane preferences tolerate malformed and unavailable storage", async ({
  page,
}) => {
  await page.addInitScript(() =>
    localStorage.setItem("nset.run-pane.dense", "{invalid"),
  );
  await fixture(page);
  await charts(page);
  await expect(page.locator(".run-drawer")).toBeVisible();
  await page.evaluate(() => {
    const original = Storage.prototype.setItem;
    Storage.prototype.setItem = function (key, value) {
      if (key.startsWith("nset.run-pane."))
        throw new Error("Blocked preferences");
      original.call(this, key, value);
    };
  });
  await page
    .getByRole("button", { name: "Collapse run list", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Expand run list", exact: true })
    .click();
  await expect(page.locator(".run-drawer")).toBeVisible();
  await expect(page.locator("#global-error")).toBeHidden();
});

test("full shell: one cursor activation places A then B while armed drags still zoom", async ({
  page,
}) => {
  await fixture(page);
  await charts(page);
  const card = page.locator(".chart-card").first();
  await card
    .getByRole("button", { name: "Add vertical cursor", exact: true })
    .click();
  const overlay = card.locator(".u-over");
  const box = (await overlay.boundingBox())!;
  await page.mouse.move(box.x + box.width * 0.2, box.y + box.height * 0.3);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width * 0.8, box.y + box.height * 0.7, {
    steps: 5,
  });
  await page.mouse.up();
  await expect(
    card.getByLabel("Cursor A coordinate", { exact: true }),
  ).toHaveValue("");
  await expect(
    card.getByRole("button", { name: "Place vertical cursor A", exact: true, includeHidden: true }),
  ).toHaveAttribute("aria-pressed", "true");
  for (const [letter, fraction] of [
    ["A", 0.25],
    ["B", 0.75],
  ] as const) {
    const r = (await overlay.boundingBox())!;
    await page.mouse.click(r.x + r.width * fraction, r.y + r.height * 0.5);
    await expect(
      card.getByLabel(`Cursor ${letter} coordinate`, { exact: true }),
    ).not.toHaveValue("");
  }
  await expect(
    card.getByRole("button", { name: "Add vertical cursor", exact: true }),
  ).toHaveAttribute("aria-pressed", "false");
  await expect(
    card.locator(".card-position-readout output").last(),
  ).not.toHaveText("\u2014");
});
