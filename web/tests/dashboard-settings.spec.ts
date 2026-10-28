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
