import { test, expect, type Page } from "@playwright/test";
const runs = [0, 1].map((i) => ({
  id: `r${i}`,
  experiment_id: "e",
  name: `Run ${i}`,
  created_at: 1700000000000 + i * 100000,
  updated_at: 1700000100000,
  status: "finished",
  params: {},
  tags: {},
}));
async function fixture(page: Page) {
  await page.route("**/api/**", async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname === "/api/catalog")
      return route.fulfill({
        json: {
          experiments: [{ id: "e", name: "Timing", created_at: 1 }],
          runs,
          series: runs.flatMap((r) =>
            ["train/loss", "eval/score", "eval/image"].map((key) => ({
              run_id: r.id,
              key,
              kind: key.endsWith("image") ? "image" : "metric",
              count: 3,
              last_step: 20,
              last_timestamp: r.created_at + 22000,
              last_value: key.endsWith("image") ? null : 1,
            })),
          ),
        },
      });
    if (url.pathname.endsWith("/images"))
      return route.fulfill({ json: { images: [] } });
    if (url.pathname.endsWith("/metrics")) {
      const run = runs.find((r) => url.pathname.includes(`/${r.id}/`))!;
      return route.fulfill({
        json: {
          snapshot: 3,
          total: 3,
          next_after: null,
          points: [0, 10, 20].map((step, i) => ({
            seq: i + 1,
            step,
            timestamp: run.created_at + 2000 + step * 1000,
            value: [1, 3, 1][i],
          })),
        },
      });
    }
    return route.fulfill({ status: 404, json: { error: "fixture missing" } });
  });
  await page.goto("/");
  await page.getByLabel("Access token", { exact: true }).fill("secret");
  await page.getByRole("button", { name: "Connect", exact: true }).click();
  await page.getByRole("button", { name: "Timing", exact: true }).click();
  await page
    .getByRole("checkbox", { name: "Select all matching runs", exact: true })
    .check();
  await page.getByRole("button", { name: "View charts", exact: true }).click();
  await page.locator('[data-card-kind="timeseries"] canvas').first().waitFor();
}
const saved = (page: Page) =>
  page.evaluate(() => {
    const lib = JSON.parse(localStorage.getItem("nset.workspaces.v2")!);
    return lib.views.find((v: any) => v.id === lib.activeByExperiment.e);
  });
const scalar = (view: any) =>
  view.sections
    .flatMap((s: any) => s.cards)
    .filter((c: any) => c.kind === "timeseries");
const dashboardSlider = (page: Page) =>
  page.getByRole("slider", { name: "Dashboard smoothing", exact: true });
const smoothingValue = (page: Page) =>
  page.getByRole("button", { name: "Edit smoothing bandwidth", exact: true });
async function setDashboardSigma(page: Page, value: number) {
  await smoothingValue(page).click();
  const input = page.getByLabel("Dashboard smoothing sigma", { exact: true });
  await input.fill(String(value));
  await input.dispatchEvent("change");
  if (await input.isVisible()) await input.press("Enter");
}
async function dragDashboardSigma(page: Page, fraction: number) {
  const slider = dashboardSlider(page);
  const box = (await slider.boundingBox())!;
  const current =
    Number(await slider.inputValue()) /
    Number(await slider.getAttribute("max"));
  await page.mouse.move(
    box.x + 8 + current * (box.width - 16),
    box.y + box.height / 2,
  );
  await page.mouse.down();
  await page.mouse.move(
    box.x + 8 + fraction * (box.width - 16),
    box.y + box.height / 2,
    { steps: 8 },
  );
  await page.mouse.up();
  return Number(await slider.inputValue());
}
async function editFirstChart(page: Page) {
  const card = page.locator('[data-card-kind="timeseries"]').first();
  await card.getByLabel("Chart actions", { exact: true }).click();
  await card.getByRole("button", { name: "Edit chart", exact: true }).click();
  return page.getByRole("dialog", { name: "Edit chart", exact: true });
}
async function setFirstChartScale(
  page: Page,
  scale: "linear" | "log" | "asinh",
  unit: "steps" | "seconds",
) {
  const editor = await editFirstChart(page);
  await editor.getByText("X axis options", { exact: true }).click();
  await editor.getByLabel("X scale", { exact: true }).selectOption(scale);
  await editor.getByRole("heading", { name: "Smoothing", exact: true }).click();
  await expect(
    editor.getByLabel(
      `Smoothing sigma (${scale === "linear" ? "" : "equivalent "}${unit})`,
      { exact: true },
    ),
  ).toBeVisible();
  await editor
    .getByRole("button", { name: "Save changes", exact: true })
    .click();
  await expect(editor).toBeHidden();
}
async function expectDashboardSigma(page: Page, value: number) {
  await expect
    .poll(async () =>
      scalar(await saved(page)).map((c: any) => ({
        smoothing: c.config.smoothing,
        // Off preserves each chart's last positive bandwidth.
        sigma: value === 0 ? 0 : c.config.smoothingSigma,
      })),
    )
    .toEqual([
      { smoothing: value > 0, sigma: value },
      { smoothing: value > 0, sigma: value },
    ]);
}
async function cursor(page: Page, x: number) {
  const card = page.locator('[data-card-kind="timeseries"]').first();
  // Cards may survive a setting change in place (cursors/zoom preserved), so
  // only arm the cursor and open the editor when they are not already active.
  const input = card.getByLabel("Cursor A coordinate", { exact: true });
  if (!(await input.isVisible())) {
    const add = card.getByRole("button", {
      name: "Add vertical cursor",
      exact: true,
    });
    if ((await add.getAttribute("aria-pressed")) !== "true") await add.click();
    await card.getByText("Edit positions", { exact: true }).click();
  }
  await input.fill(String(x));
  await input.press("Tab");
  return card
    .locator(".card-value-table tr")
    .filter({ hasText: "Run 0" })
    .locator("td")
    .first();
}
test("global elapsed time uses each run start, not its first sample, and persists", async ({
  page,
}) => {
  await fixture(page);
  const axis = page.getByLabel("Dashboard X axis", { exact: true });
  await axis.selectOption("relative");
  await expect(await cursor(page, 5000)).toHaveText("1.6");
  const rows = page
    .locator('[data-card-kind="timeseries"]')
    .first()
    .locator(".card-value-table tr")
    .filter({ hasText: "Run 1" });
  await expect(rows.locator("td").first()).toHaveText("1.6");
  expect(
    scalar(await saved(page)).every((c: any) => c.config.axis === "relative"),
  ).toBe(true);
  await page.reload();
  await expect(
    page.getByLabel("Dashboard X axis", { exact: true }),
  ).toHaveValue("relative");
  await page
    .getByLabel("Dashboard X axis", { exact: true })
    .selectOption("timestamp");
  await expect(await cursor(page, runs[0].created_at + 7000)).toHaveText("2");
  await page
    .getByLabel("Dashboard X axis", { exact: true })
    .selectOption("step");
  await expect(await cursor(page, 5)).toHaveText("2");
});
test("global smoothing updates folded scalar charts but never recreates image panels", async ({
  page,
}) => {
  await fixture(page);
  await page
    .locator('[data-card-kind="image"] .image-canvas')
    .evaluate((el) => ((window as any).imageIdentity = el));
  await page
    .getByRole("button", { name: "Edit smoothing bandwidth", exact: true })
    .click();
  await page
    .getByLabel("Dashboard smoothing sigma", { exact: true })
    .fill("50");
  await page
    .getByLabel("Dashboard smoothing sigma", { exact: true })
    .dispatchEvent("change");
  // Independent three-observation weighted fit; the cursor at 5 interpolates
  // between fitted knots at 0 and 10, not a sample-count EMA.
  const fit = (x: number) => {
    let s0 = 0,
      s1 = 0,
      s2 = 0,
      t0 = 0,
      t1 = 0;
    for (const [step, value] of [
      [0, 1],
      [10, 3],
      [20, 1],
    ]) {
      const d = (step - x) / 50,
        w = Math.exp((-d * d) / 2);
      s0 += w;
      s1 += w * d;
      s2 += w * d * d;
      t0 += w * value;
      t1 += w * d * value;
    }
    return (t0 * s2 - t1 * s1) / (s0 * s2 - s1 * s1);
  };
  const value = await cursor(page, 5);
  await expect
    .poll(async () => Number(await value.textContent()))
    .toBeCloseTo((fit(0) + fit(10)) / 2, 5);
  expect(
    scalar(await saved(page)).every(
      (c: any) => c.config.smoothing && c.config.smoothingSigma === 50,
    ),
  ).toBe(true);
  expect(
    await page
      .locator('[data-card-kind="image"] .image-canvas')
      .evaluate((el) => el === (window as any).imageIdentity),
  ).toBe(true);
  await page
    .getByRole("slider", { name: "Dashboard smoothing", exact: true })
    .press("Home");
  await expect(await cursor(page, 5)).toHaveText("2");
});
test("failed global setting save restores configs and keyboard focus", async ({
  page,
}) => {
  await fixture(page);
  await page.evaluate(() => {
    const original = Storage.prototype.setItem;
    Storage.prototype.setItem = function (key, value) {
      if (key === "nset.workspaces.v2") throw Error("quota");
      return original.call(this, key, value);
    };
  });
  await page
    .getByLabel("Dashboard X axis", { exact: true })
    .selectOption("relative");
  await expect(
    page.getByLabel("Dashboard X axis", { exact: true }),
  ).toHaveValue("step");
  await expect(page.locator("#global-error")).toContainText("Could not save");
  expect(
    scalar(await saved(page)).every((c: any) => c.config.axis === "step"),
  ).toBe(true);
  await expect(await cursor(page, 5)).toHaveText("2");
});

test("smoothing slider retains its expanded maximum across downward drags and toolbar rebuilds", async ({
  page,
}) => {
  await fixture(page);
  const slider = page.getByRole("slider", {
    name: "Dashboard smoothing",
    exact: true,
  });
  await page
    .getByRole("button", { name: "Edit smoothing bandwidth", exact: true })
    .click();
  await page
    .getByLabel("Dashboard smoothing sigma", { exact: true })
    .fill("1000");
  await page
    .getByLabel("Dashboard smoothing sigma", { exact: true })
    .dispatchEvent("change");
  await expect(slider).toHaveAttribute("max", "1000");
  await expect(slider).toHaveValue("1000");
  for (const fraction of [0.6, 0.3]) {
    const box = (await slider.boundingBox())!;
    const current = Number(await slider.inputValue()) / 1000;
    await page.mouse.move(
      box.x + 8 + current * (box.width - 16),
      box.y + box.height / 2,
    );
    await page.mouse.down();
    await page.mouse.move(
      box.x + 8 + fraction * (box.width - 16),
      box.y + box.height / 2,
      { steps: 8 },
    );
    await page.mouse.up();
    await expect(slider).toHaveAttribute("max", "1000");
    const value = Number(await slider.inputValue());
    expect(value).toBeGreaterThan(1000 * (fraction - 0.1));
    expect(value).toBeLessThan(1000 * (fraction + 0.1));
    expect(
      scalar(await saved(page)).every(
        (c: any) => c.config.smoothingSigma === value,
      ),
    ).toBe(true);
  }
  await slider.press("Home");
  await expect(slider).toHaveValue("0");
  await expect(slider).toHaveAttribute("max", "1000");
  await slider.press("End");
  await expect(slider).toHaveValue("1000");
  await expect(slider).toHaveAttribute("max", "1000");
  await page.getByRole("button", { name: "Runs", exact: true }).first().click();
  await page.getByRole("button", { name: "View charts", exact: true }).click();
  await expect(slider).toHaveAttribute("max", "1000");
  await slider.press("ArrowLeft");
  await expect(slider).toHaveAttribute("max", "1000");
  expect(Number(await slider.inputValue())).toBeLessThan(1000);
});

test("explicit sub-second bounds replace larger ranges and retain linear resolution", async ({
  page,
}) => {
  await fixture(page);
  await page
    .getByRole("combobox", { name: "Dashboard X axis" })
    .selectOption("relative");
  const slider = page.getByRole("slider", {
    name: "Dashboard smoothing",
    exact: true,
  });
  for (const max of [1000, 1, 0.01]) {
    await page
      .getByRole("button", { name: "Edit smoothing bandwidth", exact: true })
      .click();
    const input = page.getByLabel("Dashboard smoothing sigma", { exact: true });
    await input.fill(String(max));
    await input.dispatchEvent("change");
    await expect(slider).toHaveAttribute("max", String(max));
    await expect(slider).toHaveAttribute("step", String(max / 1000));
    await expect(slider).toHaveValue(String(max));
    for (const fraction of [0.2, 0.8]) {
      const box = (await slider.boundingBox())!;
      const current = Number(await slider.inputValue()) / max;
      await page.mouse.move(
        box.x + 8 + current * (box.width - 16),
        box.y + box.height / 2,
      );
      await page.mouse.down();
      await page.mouse.move(
        box.x + 8 + fraction * (box.width - 16),
        box.y + box.height / 2,
        { steps: 8 },
      );
      await page.mouse.up();
      await expect(slider).toHaveAttribute("max", String(max));
      const value = Number(await slider.inputValue());
      expect(value / max).toBeGreaterThan(fraction - 0.1);
      expect(value / max).toBeLessThan(fraction + 0.1);
      expect((value / max) * 1000).toBeCloseTo(
        Math.round((value / max) * 1000),
        8,
      );
    }
    await slider.press("Home");
    await slider.press("ArrowRight");
    expect(Number(await slider.inputValue())).toBeCloseTo(max / 1000, 12);
    await expect(slider).toHaveAttribute("max", String(max));
  }
});

for (const { axis, unit, max } of [
  { axis: "step", unit: "steps", max: 100 },
  { axis: "relative", unit: "seconds", max: 1 },
] as const) {
  test(`mixed linear/nonlinear ${unit} retain dashboard bandwidth, range and Off`, async ({
    page,
  }) => {
    await fixture(page);
    await page
      .getByLabel("Dashboard X axis", { exact: true })
      .selectOption(axis);
    await setDashboardSigma(page, max);
    const slider = dashboardSlider(page);
    const initial = await dragDashboardSigma(page, 0.75);
    expect(initial).toBeGreaterThan(max * 0.65);
    expect(initial).toBeLessThan(max * 0.85);
    await expectDashboardSigma(page, initial);
    const signature = await page
      .locator("#workspace-toolbar")
      .getAttribute("data-smoothing-signature");
    expect(signature).toBe(unit);

    // Change only one chart through the real editor; the other stays linear.
    await setFirstChartScale(page, "log", unit);
    expect(
      scalar(await saved(page))
        .map((c: any) => c.config.xScale)
        .sort(),
    ).toEqual(["linear", "log"]);
    await expect(slider).toBeEnabled();
    await expect(smoothingValue(page)).toBeEnabled();
    await expect(smoothingValue(page)).toHaveText(`${initial} ${unit}`);
    await expect(page.locator("#workspace-toolbar")).toHaveAttribute(
      "data-smoothing-signature",
      signature!,
    );
    await expect(slider).toHaveAttribute("max", String(max));
    await expect(slider).toHaveAttribute("step", String(max / 1000));
    await expect(slider).toHaveValue(String(initial));
    await expectDashboardSigma(page, initial);

    const dragged = await dragDashboardSigma(page, 0.3);
    expect(dragged).toBeGreaterThan(max * 0.2);
    expect(dragged).toBeLessThan(max * 0.4);
    await expectDashboardSigma(page, dragged);
    await expect(slider).toHaveAttribute("max", String(max));
    await slider.press("Home");
    await expectDashboardSigma(page, 0);
    await expect(smoothingValue(page)).toHaveText("Off");

    // Each save rebuilds the toolbar: neither scale nor its editor unit can
    // change the dashboard's raw-unit signature or resurrect smoothing.
    for (const scale of ["asinh", "linear", "log"] as const) {
      await setFirstChartScale(page, scale, unit);
      await expect(smoothingValue(page)).toHaveText("Off");
      await expect(slider).toHaveValue("0");
      await expect(slider).toHaveAttribute("max", String(max));
      await expect(page.locator("#workspace-toolbar")).toHaveAttribute(
        "data-smoothing-signature",
        signature!,
      );
      await expectDashboardSigma(page, 0);
    }
    await slider.press("End");
    await expectDashboardSigma(page, max);
    await dragDashboardSigma(page, 0);
    await expect(slider).toHaveValue("0");
    await expectDashboardSigma(page, 0);
    await page
      .getByRole("button", { name: "Runs", exact: true })
      .first()
      .click();
    await page
      .getByRole("button", { name: "View charts", exact: true })
      .click();
    await expect(smoothingValue(page)).toHaveText("Off");
    await expect(slider).toHaveValue("0");
    await expect(slider).toHaveAttribute("max", String(max));
    await slider.press("End");
    await expectDashboardSigma(page, max);
    await page.reload();
    await expect(slider).toBeEnabled();
    await expect(slider).toHaveValue(String(max));
    await expect(slider).toHaveAttribute("max", String(max));
    await expect(smoothingValue(page)).toHaveText(`${max} ${unit}`);
    await expectDashboardSigma(page, max);
    expect(
      scalar(await saved(page))
        .map((c: any) => c.config.xScale)
        .sort(),
    ).toEqual(["linear", "log"]);
  });
}

test("genuinely mixed step/time charts remain Off after toolbar rebuild and reload", async ({
  page,
}) => {
  await fixture(page);
  await setDashboardSigma(page, 10);
  const editor = await editFirstChart(page);
  await editor.getByLabel("X", { exact: true }).selectOption("param:relative");
  await editor
    .getByRole("button", { name: "Save changes", exact: true })
    .click();
  await expect(editor).toBeHidden();
  await expect(smoothingValue(page)).toHaveText("Mixed units");
  await expect(smoothingValue(page)).toBeDisabled();
  await dashboardSlider(page).press("Home");
  await expectDashboardSigma(page, 0);
  await expect(smoothingValue(page)).toHaveText("Off");
  await page.getByRole("button", { name: "Runs", exact: true }).first().click();
  await page.getByRole("button", { name: "View charts", exact: true }).click();
  await expect(smoothingValue(page)).toHaveText("Off");
  await expect(dashboardSlider(page)).toHaveValue("0");
  await page.reload();
  await expect(smoothingValue(page)).toHaveText("Off");
  await expect(dashboardSlider(page)).toHaveValue("0");
  await expectDashboardSigma(page, 0);
  expect(
    scalar(await saved(page))
      .map((c: any) => c.config.axis)
      .sort(),
  ).toEqual(["relative", "step"]);
});

test("failed mixed-scale smoothing save restores bandwidth, range and focus", async ({
  page,
}) => {
  await fixture(page);
  await setDashboardSigma(page, 100);
  await setFirstChartScale(page, "log", "steps");
  const before = scalar(await saved(page));
  await page.evaluate(() => {
    const original = Storage.prototype.setItem;
    Storage.prototype.setItem = function (key, value) {
      if (key === "nset.workspaces.v2") throw Error("quota");
      return original.call(this, key, value);
    };
  });
  const slider = dashboardSlider(page);
  await slider.press("Home");
  await expect(slider).toHaveValue("100");
  await expect(slider).toHaveAttribute("max", "100");
  await expect(slider).toBeFocused();
  await expect(smoothingValue(page)).toHaveText("100 steps");
  await expect(page.locator("#global-error")).toContainText("Could not save");
  expect(scalar(await saved(page))).toEqual(before);
});
