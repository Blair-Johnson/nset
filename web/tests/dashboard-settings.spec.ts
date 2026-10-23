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
  await page.getByLabel("Dashboard smoothing", { exact: true }).fill("50");
  await expect(await cursor(page, 5)).toHaveText("1.1");
  expect(
    scalar(await saved(page)).every(
      (c: any) => c.config.smoothing && c.config.alpha === 0.1,
    ),
  ).toBe(true);
  expect(
    await page
      .locator('[data-card-kind="image"] .image-canvas')
      .evaluate((el) => el === (window as any).imageIdentity),
  ).toBe(true);
  await page.getByLabel("Dashboard smoothing", { exact: true }).fill("0");
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
