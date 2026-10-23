import { test, expect, type Page } from "@playwright/test";

async function fixture(page: Page) {
  const run = {
    id: "review-run",
    experiment_id: "review-experiment",
    name: "Review run",
    status: "finished",
    created_at: 1700000000000,
    updated_at: 1700000002000,
    params: { train: { optim: { lr: 0.002 }, enabled: false } },
    tags: {},
  };
  await page.route("**/api/**", (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === "/api/catalog")
      return route.fulfill({
        json: {
          experiments: [
            { id: run.experiment_id, name: "Review experiment", created_at: 1 },
          ],
          runs: [run],
          series: [
            {
              run_id: run.id,
              key: "loss",
              kind: "metric",
              count: 3,
              last_step: 2,
              last_timestamp: run.updated_at,
              last_value: 1,
            },
          ],
        },
      });
    if (path.endsWith("/metrics"))
      return route.fulfill({
        json: {
          snapshot: 3,
          total: 3,
          next_after: null,
          points: [3, 2, 1].map((value, step) => ({
            seq: step + 1,
            step,
            timestamp: run.created_at + step * 1000,
            value,
          })),
        },
      });
    return route.fulfill({ status: 404, json: { error: "fixture missing" } });
  });
  await page.goto("/");
  await page.getByLabel("Access token", { exact: true }).fill("secret");
  await page.getByRole("button", { name: "Connect", exact: true }).click();
  await page
    .getByRole("button", { name: "Review experiment", exact: true })
    .click();
}

test("Undo retains keyboard identity across two consecutive edits", async ({
  page,
}) => {
  await fixture(page);
  await page
    .getByRole("checkbox", { name: "Select all matching runs", exact: true })
    .check();
  await page.getByRole("button", { name: "View charts", exact: true }).click();
  await expect(
    page.locator('[data-card-kind="timeseries"] canvas').first(),
  ).toBeVisible();
  const axis = page.getByLabel("Dashboard X axis", { exact: true });
  await axis.selectOption("timestamp");
  await axis.selectOption("relative");
  const undo = page.getByRole("button", { name: "Undo", exact: true });
  await undo.focus();
  await page.keyboard.press("Enter");
  await expect(axis).toHaveValue("timestamp");
  await expect(undo).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(axis).toHaveValue("step");
});

test("cross-tab detail swatch refresh preserves configuration search and expansion", async ({
  page,
  context,
}) => {
  await fixture(page);
  await page.getByRole("button", { name: "Review run", exact: true }).click();
  await page.getByRole("button", { name: "Collapse all", exact: true }).click();
  const search = page.getByRole("searchbox", {
    name: "Search configuration paths and values",
    exact: true,
  });
  await search.fill("0.002");
  await expect(
    page.locator(".run-config-value").filter({ hasText: /^0\.002$/ }),
  ).toBeVisible();
  await search.evaluate((node) => {
    (window as any).__configSearch = node;
  });
  const expanded = await page
    .locator(".run-config [aria-expanded]")
    .evaluateAll((nodes) =>
      nodes.map((node) => [
        node.getAttribute("aria-label"),
        node.getAttribute("aria-expanded"),
      ]),
    );
  const other = await context.newPage();
  await fixture(other);
  await other.getByRole("button", { name: "Review run", exact: true }).click();
  await other
    .getByRole("button", { name: "Change color for Review run", exact: true })
    .click();
  await other.getByLabel("Custom color", { exact: true }).fill("#123456");
  await other.getByRole("button", { name: "Apply", exact: true }).click();
  await expect
    .poll(() =>
      page
        .getByRole("button", {
          name: "Change color for Review run",
          exact: true,
        })
        .evaluate((node) => getComputedStyle(node, "::before").backgroundColor),
    )
    .toBe("rgb(18, 52, 86)");
  await expect(search).toHaveValue("0.002");
  expect(
    await search.evaluate((node) => node === (window as any).__configSearch),
  ).toBe(true);
  expect(
    await page
      .locator(".run-config [aria-expanded]")
      .evaluateAll((nodes) =>
        nodes.map((node) => [
          node.getAttribute("aria-label"),
          node.getAttribute("aria-expanded"),
        ]),
      ),
  ).toEqual(expanded);
  await search.fill("");
  await expect(
    page.getByRole("button", { name: "Toggle train", exact: true }),
  ).toHaveAttribute("aria-expanded", "false");
  await other.close();
});
