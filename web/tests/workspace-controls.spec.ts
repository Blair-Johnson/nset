import { test, expect, type Page } from "@playwright/test";

type Axis = "step" | "timestamp" | "relative" | null;
async function fixture(
  page: Page,
  axis: Axis = "step",
  smoothing: number | null = 2.5,
  smoothingUnit: string | null = "steps",
) {
  await page.route("**/__workspace_controls_fixture", (route) =>
    route.fulfill({
      contentType: "text/html",
      body: '<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"></head><body><div id="toolbar" style="padding:8px;display:flex;align-items:center;flex-wrap:wrap;gap:8px"></div></body></html>',
    }),
  );
  await page.goto("/__workspace_controls_fixture");
  await page.evaluate(
    async ({ axis, smoothing, smoothingUnit }) => {
      await import("/src/style.css");
      const { createDashboardControls } =
        await import("/src/workspace-controls.ts");
      const state = ((window as any).__controls = {
        axes: [] as string[],
        sigmas: [] as number[],
        failAxis: false,
        failSmoothing: false,
        throwSmoothing: false,
      });
      document.querySelector("#toolbar")!.append(
        createDashboardControls({
          axis,
          smoothing,
          smoothingUnit,
          onAxis: (value: string) => {
            state.axes.push(value);
            return !state.failAxis;
          },
          onSmoothing: (value: number) => {
            state.sigmas.push(value);
            if (state.throwSmoothing) throw new Error("storage failed");
            return !state.failSmoothing;
          },
        }),
      );
    },
    { axis, smoothing, smoothingUnit },
  );
}
const state = (page: Page) => page.evaluate(() => (window as any).__controls);
const slider = (page: Page) =>
  page.getByRole("slider", { name: "Dashboard smoothing", exact: true });
const valueButton = (page: Page) =>
  page.getByRole("button", { name: "Edit smoothing bandwidth", exact: true });
const sigma = (page: Page) =>
  page.getByRole("textbox", { name: "Dashboard smoothing sigma", exact: true });
async function editSigma(page: Page) {
  if (!(await sigma(page).isVisible())) await valueButton(page).click();
  return sigma(page);
}
async function commitSigma(page: Page, value: number | string) {
  const input = await editSigma(page);
  await input.fill(String(value));
  await input.dispatchEvent("change");
}

test("mixed bandwidth displays without applying a placeholder; exact change commits", async ({
  page,
}) => {
  await fixture(page, null, null, "seconds");
  const axis = page.getByRole("combobox", { name: "Dashboard X axis" });
  await expect(axis).toHaveValue("");
  await expect(axis.locator("option:checked")).toHaveText("Mixed");
  await expect(valueButton(page)).toHaveText("Mixed");
  await valueButton(page).click();
  await expect(valueButton(page)).toBeHidden();
  await expect(sigma(page)).toHaveAttribute("type", "text");
  await expect(sigma(page)).toHaveValue("");
  await expect(sigma(page)).toHaveAttribute("placeholder", "Mixed");
  await sigma(page).fill("0.25");
  expect((await state(page)).sigmas).toEqual([]);
  await sigma(page).dispatchEvent("change");
  expect((await state(page)).sigmas).toEqual([0.25]);
  await sigma(page).press("Enter");
  await expect(sigma(page)).toBeHidden();
  await expect(valueButton(page)).toHaveText("0.25 seconds");
  await axis.selectOption("relative");
  expect((await state(page)).axes).toEqual(["relative"]);
});

test("native slider previews until release, uses equal intervals, and reaches Off with Home", async ({
  page,
}) => {
  await fixture(page, "relative", 1, "seconds");
  const range = slider(page);
  await expect(range).toHaveAttribute("type", "range");
  await expect(range).toHaveAttribute("min", "0");
  await expect(range).toHaveAttribute("max", "1");
  await expect(range).toHaveAttribute("step", "0.001");
  await expect(range).toHaveValue("1");
  await expect(valueButton(page)).toHaveText("1 seconds");
  await expect(page.getByRole("spinbutton")).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "Turn dashboard smoothing off" }),
  ).toHaveCount(0);
  const box = (await range.boundingBox())!;
  await page.mouse.move(box.x + box.width * 0.37, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width * 0.73, box.y + box.height / 2);
  const preview = Number(await range.inputValue());
  expect(preview).toBeGreaterThan(0);
  expect(preview).toBeLessThan(1);
  expect((await state(page)).sigmas).toEqual([]);
  await page.mouse.up();
  expect((await state(page)).sigmas).toEqual([preview]);
  expect(preview * 1000).toBeCloseTo(Math.round(preview * 1000), 9);
  await range.press("Home");
  await expect(range).toHaveValue("0");
  await expect(valueButton(page)).toHaveText("Off");
  for (const value of [0.001, 0.002, 0.003]) {
    await range.press("ArrowRight");
    expect((await state(page)).sigmas.at(-1)).toBe(value);
    await expect(range).toHaveAttribute("max", "1");
  }
});

test("exact bandwidth is unrounded and expands the slider beyond its saved maximum", async ({
  page,
}) => {
  await fixture(page, "step", 1250.125);
  await expect(slider(page)).toHaveAttribute("max", "1250.125");
  await commitSigma(page, 12500.123456);
  await expect(sigma(page)).toHaveValue("12500.123456");
  await expect(slider(page)).toHaveAttribute("max", "12500.123456");
  await expect(slider(page)).toHaveValue("12500.123456");
  await sigma(page).press("Enter");
  await expect(valueButton(page)).toHaveText("12500 steps");
  await commitSigma(page, 0.123456789);
  await sigma(page).press("Enter");
  expect((await state(page)).sigmas).toEqual([12500.123456, 0.123456789]);
  await expect(valueButton(page)).toHaveText("0.1235 steps");
  await expect(slider(page)).toHaveAttribute("max", "0.123456789");
  await expect(slider(page)).toHaveAttribute(
    "step",
    String(0.123456789 / 1000),
  );
  await slider(page).press("Home");
  await slider(page).press("ArrowRight");
  expect((await state(page)).sigmas.at(-1)).toBeCloseTo(0.123456789 / 1000, 14);
});

test("Escape cancels exact edits and invalid bandwidth never commits", async ({
  page,
}) => {
  await fixture(page);
  const input = await editSigma(page);
  await input.fill("99.12345");
  await input.press("Escape");
  await expect(sigma(page)).toBeHidden();
  await expect(valueButton(page)).toHaveText("2.5 steps");
  expect((await state(page)).sigmas).toEqual([]);
  for (const invalid of ["-1", "Infinity", "NaN", "", "not a number"]) {
    await commitSigma(page, invalid);
    await expect(sigma(page)).toHaveValue("2.5");
    await expect(slider(page)).toHaveValue("2.5");
  }
  expect((await state(page)).sigmas).toEqual([]);
});

test("mixed units reject nonzero slider edits but allow keyboard Off", async ({
  page,
}) => {
  await fixture(page, null, 2.5, null);
  const range = slider(page);
  await expect(range).toBeEnabled();
  await expect(valueButton(page)).toBeDisabled();
  await expect(valueButton(page)).toHaveText("Mixed units");
  await range.press("End");
  expect((await state(page)).sigmas).toEqual([]);
  await expect(range).toHaveValue("1");
  await expect(valueButton(page)).toHaveText("Mixed units");
  await range.press("Home");
  expect((await state(page)).sigmas).toEqual([0]);
  await expect(range).toHaveValue("0");
  await expect(valueButton(page)).toHaveText("Off");
});

test("failed callbacks restore saved values and preserve focus", async ({
  page,
}) => {
  await fixture(page);
  const axis = page.getByRole("combobox", { name: "Dashboard X axis" });
  await commitSigma(page, 4.5);
  await sigma(page).press("Enter");
  await page.evaluate(() => {
    (window as any).__controls.failAxis = true;
    (window as any).__controls.failSmoothing = true;
  });
  await axis.focus();
  await axis.selectOption("relative");
  await expect(axis).toHaveValue("step");
  await expect(axis).toBeFocused();
  await expect(page.getByRole("status")).toContainText(
    "Could not save dashboard X axis",
  );
  await slider(page).press("Home");
  await expect(slider(page)).toHaveValue("4.5");
  await expect(slider(page)).toHaveAttribute("max", "4.5");
  await expect(slider(page)).toBeFocused();
  await expect(valueButton(page)).toHaveText("4.5 steps");
  await commitSigma(page, 5);
  await expect(sigma(page)).toHaveValue("4.5");
  await expect(slider(page)).toHaveAttribute("max", "4.5");
  await expect(slider(page)).toHaveAttribute("step", "0.0045");
  await expect(sigma(page)).toBeFocused();
  await expect(page.getByRole("status")).toContainText(
    "Could not save dashboard smoothing",
  );
  await page.evaluate(() => {
    (window as any).__controls.failSmoothing = false;
  });
  await commitSigma(page, 6);
  await expect(page.getByRole("status")).toBeEmpty();
});

test("thrown mixed edits restore the empty mixed bandwidth and focus", async ({
  page,
}) => {
  await fixture(page, null, null);
  await page.evaluate(() => {
    (window as any).__controls.throwSmoothing = true;
  });
  await commitSigma(page, 3);
  await expect(sigma(page)).toHaveValue("");
  await expect(sigma(page)).toHaveAttribute("placeholder", "Mixed");
  await expect(sigma(page)).toBeFocused();
  await expect(page.getByRole("status")).toContainText(
    "Previous setting restored",
  );
});

test("compact smoothing fits a narrow viewport, including mixed units and exact editing", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await fixture(page, null, null, null);
  for (const control of [slider(page), valueButton(page)]) {
    await expect(control).toBeVisible();
    const box = (await control.boundingBox())!;
    expect(box.height).toBeGreaterThanOrEqual(28);
    expect(box.x + box.width).toBeLessThanOrEqual(390);
  }
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth),
  ).toBeLessThanOrEqual(390);
  await fixture(page);
  await editSigma(page);
  const input = (await sigma(page).boundingBox())!;
  expect(input.x + input.width).toBeLessThanOrEqual(390);
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth),
  ).toBeLessThanOrEqual(390);
});

test("rebuilt mixed-unit controls keep an all-disabled summary Off", async ({
  page,
}) => {
  await fixture(page, null, 0, null);
  await expect(slider(page)).toHaveValue("0");
  await expect(slider(page)).toHaveAttribute("aria-valuetext", "Off");
  await expect(valueButton(page)).toHaveText("Off");
  await expect(valueButton(page)).toBeDisabled();
  // Genuine step/time mixing still forbids re-enabling a numeric bandwidth.
  await slider(page).press("End");
  await expect(slider(page)).toHaveValue("0");
  await expect(valueButton(page)).toHaveText("Off");
  expect((await state(page)).sigmas).toEqual([]);
});

test("failed mixed-unit Off restores the mixed summary and keyboard focus", async ({
  page,
}) => {
  await fixture(page, null, null, null);
  await page.evaluate(() => {
    (window as any).__controls.failSmoothing = true;
  });
  await slider(page).press("Home");
  await expect(slider(page)).toHaveValue("1");
  await expect(slider(page)).toHaveAttribute("max", "1");
  await expect(slider(page)).toBeFocused();
  await expect(valueButton(page)).toHaveText("Mixed units");
  await expect(page.getByRole("status")).toContainText(
    "Previous setting restored",
  );
  expect((await state(page)).sigmas).toEqual([0]);
  await page.evaluate(() => {
    (window as any).__controls.failSmoothing = false;
  });
  await slider(page).press("Home");
  await expect(valueButton(page)).toHaveText("Off");
  await expect(page.getByRole("status")).toBeEmpty();
  expect((await state(page)).sigmas).toEqual([0, 0]);
});

test("a repeated pointer Off gesture commits after a failed save", async ({
  page,
}) => {
  await fixture(page, null, null, null);
  const range = slider(page);
  const dragOff = async () => {
    const box = (await range.boundingBox())!;
    await page.mouse.move(box.x + box.width - 8, box.y + box.height / 2);
    await page.mouse.down();
    await page.mouse.move(box.x, box.y + box.height / 2, { steps: 8 });
    await page.mouse.up();
  };
  await page.evaluate(() => {
    (window as any).__controls.failSmoothing = true;
  });
  await dragOff();
  await expect(range).toHaveValue("1");
  await expect(valueButton(page)).toHaveText("Mixed units");
  expect((await state(page)).sigmas).toEqual([0]);
  await page.evaluate(() => {
    (window as any).__controls.failSmoothing = false;
  });
  await dragOff();
  await expect(range).toHaveValue("0");
  await expect(valueButton(page)).toHaveText("Off");
  await expect(page.getByRole("status")).toBeEmpty();
  expect((await state(page)).sigmas).toEqual([0, 0]);
});
