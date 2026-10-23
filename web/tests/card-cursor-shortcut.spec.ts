import { test, expect, type Page } from "@playwright/test";

async function fixture(page: Page) {
  await page.setViewportSize({ width: 1500, height: 1100 });
  await page.route(/^http:\/\/127\.0\.0\.1:[0-9]+\/$/, (route) =>
    route.fulfill({
      contentType: "text/html",
      body: "<!doctype html><html><body></body></html>",
    }),
  );
  await page.goto("/");
  await page.evaluate(async () => {
    const { ChartCard } = await import("/src/cards.ts");
    const { newChart } = await import("/src/workspace.ts");
    document.body.style.cssText =
      "margin:12px;background:#151617;color:#ddd;display:flex;gap:12px;align-items:flex-start;--surface:#1e2022;--text:#ddd;--muted:#abb3bc;--border:#42474e";
    const run = {
      id: "r",
      name: "Baseline",
      experiment_id: "e",
      status: "finished",
      params: {},
      tags: {},
      created_at: 0,
      updated_at: 0,
    };
    const context = {
      api: {},
      catalog: {
        experiments: [],
        runs: [run],
        series: [
          {
            run_id: "r",
            key: "loss",
            kind: "metric",
            count: 3,
            last_step: 100,
            last_timestamp: 100,
            last_value: 100,
          },
        ],
      },
      selectedRunIds: ["r"],
      store: {
        clear() {},
        async load() {
          return [0, 50, 100].map((value, i) => ({
            seq: i + 1,
            step: value,
            timestamp: value,
            value,
          }));
        },
      },
    };
    const cards = [0, 1].map((i) => {
      const host = document.createElement("div");
      host.style.cssText = "flex:0 1 620px;min-width:300px";
      document.body.append(host);
      const spec = newChart("timeseries", ["loss"], `Plot ${i}`);
      spec.id = `plot-${i}`;
      spec.layout = { width: 620, height: 460 };
      return new ChartCard(host, spec, context, {
        onEdit() {},
        onDuplicate() {},
        onRemove() {},
        onMove() {},
        onResize() {},
      });
    });
    (window as any).__shortcutCards = cards;
  });
  await expect(page.locator(".u-over")).toHaveCount(2);
}
const card = (page: Page, index = 1) => page.locator(".chart-card").nth(index);
async function cycle(page: Page, index = 1) {
  await card(page, index)
    .locator(".u-over")
    .hover({ position: { x: 40, y: 45 } });
  await page.keyboard.press("c");
}
const states = (page: Page) =>
  page.evaluate(() =>
    (window as any).__shortcutCards.map((c: any) => ({
      mode: c.mode,
      axis: c.cursorAxis,
      active: c.activePin,
      pins: { ...c.pins },
      viewport: c.plot.viewport(),
    })),
  );
async function pick(page: Page, x: number, y: number) {
  const box = (await card(page).locator(".u-over").boundingBox())!;
  await page.mouse.click(box.x + box.width * x, box.y + box.height * y);
}

test("hovered real card cycles orientations and exits without losing positions or measurements", async ({
  page,
}) => {
  await fixture(page);
  await card(page, 0).locator(".uplot").focus();
  await cycle(page);
  await expect(card(page).locator(".uplot")).toHaveAttribute(
    "data-cursor-placement",
    "vertical",
  );
  await card(page).getByText("Edit positions", { exact: true }).click();
  await expect(
    card(page).getByLabel("Cursor A coordinate", { exact: true }),
  ).toBeVisible();
  expect((await states(page))[0].mode).toBe("zoom");
  await pick(page, 0.2, 0.4);
  expect((await states(page))[1].active).toBe("b");
  await pick(page, 0.8, 0.6);
  await expect(card(page).locator(".uplot")).toHaveAttribute(
    "data-cursor-placement",
    "off",
  );
  const vertical = (await states(page))[1].pins;
  expect(vertical.a).not.toBeNull();
  expect(vertical.b).not.toBeNull();
  await cycle(page);
  await cycle(page);
  await expect(card(page).locator(".uplot")).toHaveAttribute(
    "data-cursor-placement",
    "horizontal",
  );
  await expect(
    card(page).getByLabel("Cursor A level", { exact: true }),
  ).toBeVisible();
  await expect(
    card(page).getByLabel("Cursor A coordinate", { exact: true }),
  ).toHaveCount(0);
  await pick(page, 0.5, 0.3);
  const before = (await states(page))[1].pins;
  await cycle(page);
  await expect(card(page).locator(".uplot")).toHaveAttribute(
    "data-cursor-placement",
    "off",
  );
  expect((await states(page))[1].pins).toEqual(before);
  expect(before.a).toEqual(vertical.a);
  expect(before.b).toEqual(vertical.b);
  await expect(
    card(page).getByLabel("Cursor A level", { exact: true }),
  ).not.toHaveValue("");
  await cycle(page);
  await expect(card(page).locator(".uplot")).toHaveAttribute(
    "data-cursor-placement",
    "vertical",
  );
  expect((await states(page))[1].active).toBe("a");
});

test("C-armed real card still zooms, ignores coordinate typing and completes horizontal pairs", async ({
  page,
}, info) => {
  await fixture(page);
  await cycle(page);
  const before = (await states(page))[1];
  const surface = card(page).locator(".u-over");
  const box = (await surface.boundingBox())!;
  await page.mouse.move(box.x + box.width * 0.25, box.y + box.height * 0.25);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width * 0.75, box.y + box.height * 0.75, {
    steps: 8,
  });
  await page.keyboard.press("c");
  await page.mouse.up();
  const zoomed = (await states(page))[1];
  expect(zoomed.mode).toBe("inspect");
  expect(zoomed.axis).toBe("x");
  expect(zoomed.active).toBe("a");
  expect(zoomed.pins).toEqual(before.pins);
  expect(zoomed.viewport).not.toEqual(before.viewport);
  await card(page).getByText("Edit positions", { exact: true }).click();
  await card(page).getByLabel("Cursor A coordinate", { exact: true }).focus();
  await surface.hover({ position: { x: 40, y: 40 } });
  await page.keyboard.press("c");
  expect((await states(page))[1].axis).toBe("x");
  await card(page).locator(".uplot").focus();
  await cycle(page);
  await expect(card(page).locator(".uplot")).toHaveAttribute(
    "data-cursor-placement",
    "horizontal",
  );
  await pick(page, 0.45, 0.2);
  expect((await states(page))[1].active).toBe("b");
  await pick(page, 0.55, 0.8);
  const pair = (await states(page))[1];
  expect(pair.mode).toBe("zoom");
  expect(Number.isFinite(pair.pins.yA)).toBe(true);
  expect(Number.isFinite(pair.pins.yB)).toBe(true);
  await page.screenshot({
    path: info.outputPath("horizontal-pair-after-shortcut.png"),
  });
  await card(page)
    .getByRole("button", { name: "Maximize chart", exact: true })
    .click();
  await cycle(page);
  expect((await states(page))[1].axis).toBe("x");
  expect((await states(page))[1].mode).toBe("inspect");
  expect((await states(page))[1].pins).toEqual(pair.pins);
  await card(page)
    .getByRole("button", { name: "Restore chart", exact: true })
    .click();
  await cycle(page);
  expect((await states(page))[1].axis).toBe("y");
  expect((await states(page))[1].pins).toEqual(pair.pins);
});
