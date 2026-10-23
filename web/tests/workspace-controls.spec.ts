import { test, expect, type Page } from "@playwright/test";

type Axis = "step" | "timestamp" | "relative" | null;
async function fixture(
  page: Page,
  axis: Axis = "step",
  smoothing: number | null = 25,
) {
  await page.route("**/__workspace_controls_fixture", (route) =>
    route.fulfill({
      contentType: "text/html",
      body: '<!doctype html><html><body><div id="toolbar" style="padding:8px;display:flex;align-items:center;flex-wrap:wrap;gap:8px"></div><main><p>Dashboard information stays below the toolbar.</p></main></body></html>',
    }),
  );
  await page.goto("/__workspace_controls_fixture");
  await page.evaluate(
    async ({ axis, smoothing }) => {
      await import("/src/style.css");
      const { createDashboardControls } =
        await import("/src/workspace-controls.ts");
      const state = ((window as any).__controls = {
        axes: [] as string[],
        strengths: [] as number[],
        failAxis: false,
        failSmoothing: false,
        throwSmoothing: false,
      });
      document.querySelector("#toolbar")!.append(
        createDashboardControls({
          axis,
          smoothing,
          onAxis: (value: string) => {
            state.axes.push(value);
            return !state.failAxis;
          },
          onSmoothing: (value: number) => {
            state.strengths.push(value);
            if (state.throwSmoothing) throw new Error("storage failed");
            return !state.failSmoothing;
          },
        }),
      );
    },
    { axis, smoothing },
  );
}
async function commitStrength(page: Page, value: number) {
  await page
    .getByRole("slider", { name: "Dashboard smoothing" })
    .evaluate((slider: HTMLInputElement, next) => {
      slider.value = String(next);
      slider.dispatchEvent(new Event("input", { bubbles: true }));
      slider.dispatchEvent(new Event("change", { bubbles: true }));
    }, value);
}
const state = (page: Page) => page.evaluate(() => (window as any).__controls);

test("initial mixed settings are displayed without applying dashboard changes", async ({
  page,
}) => {
  await fixture(page, null, null);
  const axis = page.getByRole("combobox", { name: "Dashboard X axis" });
  const slider = page.getByRole("slider", { name: "Dashboard smoothing" });
  await expect(axis).toHaveValue("");
  await expect(axis.locator("option:checked")).toHaveText("Mixed");
  await expect(page.locator(".dashboard-smoothing-value")).toHaveText("Mixed");
  await expect(slider).toHaveAttribute("aria-valuetext", "Mixed");
  await slider.focus();
  expect((await state(page)).strengths).toEqual([]);
  expect((await state(page)).axes).toEqual([]);
  await expect(page.locator(".dashboard-smoothing-value")).toHaveText("Mixed");
  await slider.press("ArrowRight");
  await expect(page.locator(".dashboard-smoothing-value")).toHaveText("51%");
  expect((await state(page)).strengths).toEqual([51]);
  await axis.selectOption("relative");
  expect((await state(page)).axes).toEqual(["relative"]);
  await expect(axis.locator("option:checked")).toHaveText("Relative time");
  await expect(axis).toHaveAttribute("title", /each run's start/);
});

test("native slider drag previews freely and commits only once on release", async ({
  page,
}) => {
  await fixture(page, "timestamp", 0);
  const slider = page.getByRole("slider", { name: "Dashboard smoothing" });
  await expect(page.locator(".dashboard-smoothing-value")).toHaveText("None");
  const bounds = (await slider.boundingBox())!;
  await page.mouse.move(
    bounds.x + bounds.width * 0.2,
    bounds.y + bounds.height / 2,
  );
  await page.mouse.down();
  await page.mouse.move(
    bounds.x + bounds.width * 0.8,
    bounds.y + bounds.height / 2,
    { steps: 12 },
  );
  expect((await state(page)).strengths).toEqual([]);
  await expect(page.locator(".dashboard-smoothing-value")).not.toHaveText(
    "None",
  );
  const preview = Number(await slider.inputValue());
  await page.mouse.up();
  expect((await state(page)).strengths).toEqual([preview]);
  await slider.focus();
  await slider.press("End");
  await expect(page.locator(".dashboard-smoothing-value")).toHaveText("More");
  await expect(slider).toHaveAttribute("aria-valuetext", "More");
  await slider.press("Home");
  await expect(page.locator(".dashboard-smoothing-value")).toHaveText("None");
  expect((await state(page)).strengths).toEqual([preview, 100, 0]);
  await expect(slider).toBeFocused();
});

test("false callbacks restore latest saved settings and keep keyboard focus", async ({
  page,
}) => {
  await fixture(page);
  const axis = page.getByRole("combobox", { name: "Dashboard X axis" });
  const slider = page.getByRole("slider", { name: "Dashboard smoothing" });
  await axis.selectOption("timestamp");
  await commitStrength(page, 40);
  await page.evaluate(() => {
    (window as any).__controls.failAxis = true;
    (window as any).__controls.failSmoothing = true;
  });
  await axis.focus();
  await axis.selectOption("relative");
  await expect(axis).toHaveValue("timestamp");
  await expect(axis).toBeFocused();
  await expect(page.getByRole("status")).toContainText(
    "Could not save dashboard X axis. Previous setting restored.",
  );
  await slider.focus();
  await slider.press("ArrowRight");
  await expect(slider).toHaveValue("40");
  await expect(slider).toBeFocused();
  await expect(page.locator(".dashboard-smoothing-value")).toHaveText("40%");
  await expect(page.getByRole("status")).toContainText(
    "Could not save dashboard smoothing. Previous setting restored.",
  );
  expect((await state(page)).strengths).toEqual([40, 41]);
  await page.evaluate(() => {
    (window as any).__controls.failSmoothing = false;
  });
  await slider.press("ArrowRight");
  await expect(slider).toHaveValue("41");
  await expect(page.getByRole("status")).toBeEmpty();
});

test("failed mixed edits restore Mixed rather than applying the placeholder value", async ({
  page,
}) => {
  await fixture(page, null, null);
  await page.evaluate(() => {
    (window as any).__controls.failAxis = true;
    (window as any).__controls.failSmoothing = true;
  });
  const axis = page.getByRole("combobox", { name: "Dashboard X axis" });
  await axis.selectOption("step");
  await expect(axis).toHaveValue("");
  await expect(axis.locator("option:checked")).toHaveText("Mixed");
  await commitStrength(page, 80);
  await expect(page.locator(".dashboard-smoothing-value")).toHaveText("Mixed");
  await expect(page.getByRole("slider")).toHaveAttribute(
    "aria-valuetext",
    "Mixed",
  );
  expect((await state(page)).strengths).toEqual([80]);
  await page.evaluate(() => {
    (window as any).__controls.failSmoothing = false;
    (window as any).__controls.throwSmoothing = true;
  });
  await commitStrength(page, 90);
  await expect(page.locator(".dashboard-smoothing-value")).toHaveText("Mixed");
  await expect(page.getByRole("status")).toContainText(
    "Previous setting restored.",
  );
});

test("compact controls have stable geometry, padded selects and a narrow-screen layout", async ({
  page,
}) => {
  await fixture(page);
  const controls = page.getByRole("group", { name: "Dashboard controls" });
  const before = (await controls.boundingBox())!;
  expect(before.height).toBeLessThanOrEqual(34);
  expect(before.width).toBeLessThanOrEqual(470);
  expect(
    await page
      .getByRole("combobox")
      .evaluate((el) => parseFloat(getComputedStyle(el).paddingRight)),
  ).toBeGreaterThanOrEqual(26);
  await commitStrength(page, 100);
  await page.evaluate(() => {
    (window as any).__controls.failSmoothing = true;
  });
  await commitStrength(page, 10);
  const after = (await controls.boundingBox())!;
  expect(after).toEqual(before);
  await page.screenshot({
    path: "test-results/workspace-controls-desktop.png",
  });
  await page.setViewportSize({ width: 390, height: 844 });
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth),
  ).toBeLessThanOrEqual(390);
  const narrow = (await controls.boundingBox())!;
  expect(narrow.height).toBeLessThanOrEqual(64);
  const select = (await page.getByRole("combobox").boundingBox())!;
  const slider = (await page.getByRole("slider").boundingBox())!;
  expect(select.height).toBeGreaterThanOrEqual(28);
  expect(slider.height).toBeGreaterThanOrEqual(28);
  expect(select.x + select.width).toBeLessThanOrEqual(390);
  expect(slider.x + slider.width).toBeLessThanOrEqual(390);
  await page.screenshot({ path: "test-results/workspace-controls-narrow.png" });
});
